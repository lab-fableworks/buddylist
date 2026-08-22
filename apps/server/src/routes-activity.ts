/**
 * "What are you working on?" routes.
 *
 * The point of these endpoints is that a human never has to interrupt an agent to find out
 * what it is doing: the agent keeps a live activity record, and anyone who can see the agent
 * can read it — plus a project-wide standup view that answers the question for a whole team at once.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "./app.js";
import { badRequest, notFound } from "./errors.js";

export const ActivityInput = z.object({
  headline: z.string().min(1).max(200),
  detail: z.string().max(2000).optional(),
  step: z.string().max(200).optional(),
  progress: z.number().min(0).max(100).optional(),
  blockers: z.array(z.string().max(500)).max(20).optional(),
  task_id: z.string().max(200).optional(),
  project: z.string().max(80).optional(),
  eta: z.string().datetime().optional(),
  started_at: z.string().datetime().optional(),
});

export function registerActivityRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, users, projects, activity, messages } = ctx;

  const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    return r.data;
  };

  // ---- agent maintains its own record ----
  app.put("/api/me/activity", async (req) => {
    const body = parse(ActivityInput, req.body);
    return activity.set(req.user.id, req.user.screen_name, body);
  });
  app.delete("/api/me/activity", async (req) => {
    await activity.set(req.user.id, req.user.screen_name, null);
    return { ok: true };
  });

  // ---- anyone asks "what are you working on?" ----
  app.get("/api/users/:name/activity", async (req) => {
    const { name } = req.params as { name: string };
    const u = await users.byScreenName(name);
    if (!u) throw notFound("user");
    const [act, presence] = await Promise.all([activity.get(u.id), users.presenceOf(u.id)]);

    // Recent task-shaped messages the *asker* is allowed to see, so the answer has
    // provenance rather than being a bare self-report.
    const recent = await db.query<{ payload_type: string; body: string; ts: string; sender: string }>(
      `SELECT m.payload_type, m.body, m.ts, s.screen_name AS sender
         FROM messages m
         JOIN users s ON s.id = m.sender_id
         JOIN conv_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
        WHERE m.sender_id = $1 AND m.deleted_at IS NULL
          AND (m.payload_type LIKE 'task.%' OR m.payload_type = 'status.broadcast' OR m.payload_type = 'handoff')
        ORDER BY m.ts DESC LIMIT 5`,
      [u.id, req.user.id],
    );

    return {
      screen_name: u.screen_name,
      kind: u.kind,
      presence: presence.state === "invisible" ? { state: "offline" } : presence,
      activity: act,
      /** True when the agent has not refreshed its activity in a while — treat the headline as stale. */
      stale: !!act?.updated_at && Date.now() - Date.parse(act.updated_at) > 15 * 60_000,
      recent_work: recent,
      /** How to follow up if the record does not answer the question. */
      ask: { hint: `IM ${u.screen_name} with a question payload for a direct answer`, endpoint: `/api/ims/${u.screen_name}/messages` },
    };
  });

  // ---- standup: what is everyone on this project doing right now ----
  app.get("/api/projects/:slug/activity", async (req) => {
    const { slug } = req.params as { slug: string };
    const p = await projects.bySlug(slug);
    if (!p) throw notFound("project");
    await projects.requireRole(p.id, req.user.id, "observer");
    const rows = await db.query<{ id: string; screen_name: string; kind: string; role: string; activity: unknown }>(
      `SELECT u.id, u.screen_name, u.kind, m.role, u.activity
         FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 ORDER BY u.kind DESC, u.screen_name`,
      [p.id],
    );
    return {
      project: p.slug,
      as_of: new Date().toISOString(),
      members: await Promise.all(
        rows.map(async (r) => {
          const presence = await users.presenceOf(r.id);
          return {
            screen_name: r.screen_name,
            kind: r.kind,
            role: r.role,
            presence: presence.state === "invisible" ? { state: "offline" } : presence,
            activity: r.activity ?? null,
          };
        }),
      ),
    };
  });

  /**
   * Ask an agent a question and (optionally) wait for its answer, without the asker
   * needing a WebSocket. This is the "interrupt politely" path for humans in the client.
   */
  app.post("/api/users/:name/ask", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { text, wait_seconds } = parse(z.object({ text: z.string().min(1).max(2000), wait_seconds: z.number().int().min(0).max(120).default(30) }), req.body);
    const target = await users.byScreenName(name);
    if (!target) throw notFound("user");
    if (target.id === req.user.id) throw badRequest("cannot ask yourself");

    const question_id = crypto.randomUUID();
    const conv = await messages.imConversation(req.user.id, target.id);
    const sent = await messages.send(conv, req.user.id, { body: text, payload_type: "question", payload: { question_id, text }, attachments: [] });

    const answer = wait_seconds > 0 ? await waitForAnswer(conv, sent.seq, question_id, wait_seconds * 1000) : null;
    return reply.status(answer ? 200 : 202).send({
      question_id,
      conversation_id: conv,
      asked: sent.seq,
      answer,
      // If nobody answered, the activity record is the next best thing.
      activity: answer ? undefined : await activity.get(target.id),
    });
  });

  /** Poll the conversation for a correlated answer. Cheap: the window is short and indexed by (conversation, seq). */
  async function waitForAnswer(conversationId: string, afterSeq: number, questionId: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let seq = afterSeq;
    while (Date.now() < deadline) {
      const rows = await db.query<{ payload: { question_id?: string } | null; body: string; seq: number; ts: string; sender: string }>(
        `SELECT m.seq, m.body, m.payload, m.ts, u.screen_name AS sender
           FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id=$1 AND m.seq > $2 AND m.deleted_at IS NULL ORDER BY m.seq`,
        [conversationId, seq],
      );
      for (const r of rows) {
        seq = Math.max(seq, Number(r.seq));
        if (r.payload && r.payload.question_id === questionId) return { from: r.sender, body: r.body, payload: r.payload, ts: r.ts };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  }
}
