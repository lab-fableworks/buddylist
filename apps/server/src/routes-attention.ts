/**
 * "What needs me?" — the messages addressed to you that you have not answered.
 *
 * Mentions were previously fire-and-forget: published to the bus and never stored, so a
 * mention that arrived while you were offline simply never existed. Rather than start
 * recording them from now on — which would leave every past mention lost — this reads them
 * back out of the message log. The log is already the durable record; anything derived from
 * it is retroactive and cannot drift from what was actually said.
 *
 * Two independent facts about each item, because they answer different questions:
 *   - `unread`  — you have not looked at it (from the read cursor).
 *   - `answered` — you have spoken in that conversation since it arrived.
 * Reading something is not replying to it, so an item stays outstanding until you say
 * something back. That is the whole point of the view.
 */
import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AppContext } from "./app.js";
import { HttpError, badRequest, forbidden, notFound } from "./errors.js";

/** Strongest first: when one conversation triggers several ways, the most demanding wins. */
const REASON_RANK = ["question", "task.request", "review.request", "handoff", "dm", "mention"] as const;
type Reason = (typeof REASON_RANK)[number];

interface Row {
  id: string;
  conversation_id: string;
  seq: number;
  body: string;
  payload_type: string;
  payload: Record<string, unknown> | null;
  ts: string;
  sender: string;
  kind: string;
  room: string | null;
  project: string | null;
  peer: string | null;
  last_read_seq: number;
  my_last: number;
  dismissed_through: number;
}

export function registerAttentionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get("/api/attention", async (req) => {
    const q = req.query as { days?: string; all?: string; limit?: string };
    const days = Math.min(365, Math.max(1, Number(q.days ?? 30)));
    const includeAnswered = q.all === "1" || q.all === "true";
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const me = req.user.id;
    const name = req.user.screen_name;

    const rows = await db.query<Row>(
      `WITH mine AS (
         SELECT conversation_id, MAX(seq) AS my_last
           FROM messages WHERE sender_id = $1 AND deleted_at IS NULL GROUP BY conversation_id
       )
       SELECT m.id, m.conversation_id, m.seq, m.body, m.payload_type, m.payload, m.ts,
              s.screen_name AS sender, c.kind, c.name AS room, p.slug AS project,
              cm.last_read_seq, COALESCE(mine.my_last, 0) AS my_last,
              COALESCE(d.through_seq, 0) AS dismissed_through,
              (SELECT u.screen_name FROM conv_members o JOIN users u ON u.id = o.user_id
                WHERE o.conversation_id = c.id AND o.user_id <> $1 AND c.kind = 'im' LIMIT 1) AS peer
         FROM messages m
         JOIN conv_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
         JOIN conversations c ON c.id = m.conversation_id
         JOIN users s ON s.id = m.sender_id
         LEFT JOIN projects p ON p.id = c.project_id
         LEFT JOIN mine ON mine.conversation_id = m.conversation_id
         LEFT JOIN attention_dismissals d ON d.conversation_id = m.conversation_id AND d.user_id = $1
        WHERE m.sender_id <> $1
          AND m.deleted_at IS NULL
          AND m.ts > now() - ($2 || ' days')::interval
          AND (
            c.kind = 'im'
            -- Screen names are [A-Za-z0-9_] only, so this interpolation carries no regex
            -- metacharacters. The trailing class is the word boundary, spelled out rather
            -- than written as \y: a backslash escape here depends on
            -- standard_conforming_strings, and silently matches nothing when it is off.
            -- ~* not ~: screen names resolve case-insensitively, so @ZGMcginn already
            -- notifies zgmcginn. A case-sensitive view here would hide real mentions.
            OR m.body ~* ('@' || $3 || '([^A-Za-z0-9_]|$)')
            OR m.payload_type IN ('question','task.request','review.request','handoff')
          )
        ORDER BY m.ts DESC
        LIMIT 2000`,
      [me, String(days), name],
    );

    const reasonOf = (r: Row): Reason | undefined => {
      // Built from a plain string, not a template literal: a template literal turns \b into
      // a backspace character rather than a word boundary, so the pattern matches nothing.
      // The lookahead is the same boundary the SQL spells out, and must stay in step with it.
      const mentioned = new RegExp("@" + name + "(?![A-Za-z0-9_])", "i").test(r.body);
      if (r.payload_type === "question") return "question";
      // A task broadcast to a room is not addressed to you; one sent to you directly, or one
      // that names you, is. Without this every resident's task lands in everyone's queue.
      const directed = r.kind === "im" || mentioned;
      if (r.payload_type === "task.request" && directed) return "task.request";
      if (r.payload_type === "review.request" && directed) return "review.request";
      if (r.payload_type === "handoff" && (r.payload as { to?: string } | null)?.to === name) return "handoff";
      if (r.kind === "im") return "dm";
      if (mentioned) return "mention";
      return undefined;
    };

    // Collapse to one item per conversation. A thread with nine unanswered messages is one
    // thing you owe someone a reply to, not nine.
    interface Item {
      conversation_id: string;
      kind: string;
      room: string | null;
      project: string | null;
      peer: string | null;
      reason: Reason;
      reasons: Reason[];
      triggers: number;
      unread: number;
      answered: boolean;
      /** Hidden by hand. Distinct from answered: you chose not to reply, and said so. */
      dismissed: boolean;
      latest: { id: string; seq: number; ts: string; sender: string; body: string; payload_type: string };
    }
    const byConv = new Map<string, Item>();
    for (const r of rows) {
      const reason = reasonOf(r);
      if (!reason) continue;
      const answered = r.seq <= r.my_last;
      const dismissed = r.seq <= r.dismissed_through;
      if ((answered || dismissed) && !includeAnswered) continue;
      const existing = byConv.get(r.conversation_id);
      if (!existing) {
        byConv.set(r.conversation_id, {
          conversation_id: r.conversation_id,
          kind: r.kind,
          room: r.room,
          project: r.project,
          peer: r.peer,
          reason,
          reasons: [reason],
          triggers: 1,
          unread: r.seq > r.last_read_seq ? 1 : 0,
          answered,
          dismissed,
          // Rows arrive newest-first, so the first one seen is the latest.
          latest: { id: r.id, seq: r.seq, ts: r.ts, sender: r.sender, body: r.body, payload_type: r.payload_type },
        });
        continue;
      }
      existing.triggers += 1;
      if (r.seq > r.last_read_seq) existing.unread += 1;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (REASON_RANK.indexOf(reason) < REASON_RANK.indexOf(existing.reason)) existing.reason = reason;
    }

    const items = [...byConv.values()]
      .sort((a, b) => REASON_RANK.indexOf(a.reason) - REASON_RANK.indexOf(b.reason) || (a.latest.ts < b.latest.ts ? 1 : -1))
      .slice(0, limit);

    return {
      as_of: new Date().toISOString(),
      window_days: days,
      /** Outstanding conversations, not outstanding messages — the count you can act on. */
      total: items.length,
      unread: items.reduce((n, i) => n + i.unread, 0),
      by_reason: Object.fromEntries(REASON_RANK.map((r) => [r, items.filter((i) => i.reason === r).length]).filter(([, n]) => (n as number) > 0)),
      items,
    };
  });

  /** Hide a conversation's items up to `seq`. Anything said after that comes back on its own. */
  app.post("/api/attention/dismiss", async (req) => {
    const { conversation_id, seq } = parse(z.object({ conversation_id: z.string().uuid(), seq: z.number().int().min(0) }), req.body);
    const member = await db.one("SELECT 1 FROM conv_members WHERE conversation_id=$1 AND user_id=$2", [conversation_id, req.user.id]);
    if (!member) throw forbidden("not a member of this conversation");
    await db.query(
      `INSERT INTO attention_dismissals (user_id, conversation_id, through_seq) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET through_seq = GREATEST(attention_dismissals.through_seq, EXCLUDED.through_seq), dismissed_at = now()`,
      [req.user.id, conversation_id, seq],
    );
    return { ok: true };
  });
  app.delete("/api/attention/dismiss/:conversation_id", async (req) => {
    const { conversation_id } = req.params as { conversation_id: string };
    await db.query("DELETE FROM attention_dismissals WHERE user_id=$1 AND conversation_id=$2", [req.user.id, conversation_id]);
    return { ok: true };
  });

  /**
   * Draft a reply in the operator's voice, as the operator and Claude would write it together.
   * Returns text only - it never sends. The human reads it, edits it, and chooses to send, or
   * not. A draft that posts itself is an agent with the operator's name on it, which is the
   * one thing this queue exists to avoid.
   */
  app.post("/api/attention/:conversation_id/draft", async (req) => {
    const { conversation_id } = req.params as { conversation_id: string };
    const { hint } = parse(z.object({ hint: z.string().max(500).optional() }), req.body ?? {});
    if (req.user.kind !== "human") throw forbidden("drafts are for humans; agents already have a brain");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    // 503, not 500: this is setup the operator can fix, not a crash they need to debug.
    if (!apiKey) throw new HttpError(503, "unavailable", "ANTHROPIC_API_KEY is not configured on the server");
    const conv = await db.one<{ kind: string; name: string | null; topic: string; slug: string | null }>(
      `SELECT c.kind, c.name, c.topic, p.slug FROM conversations c
         JOIN conv_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
         LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = $1`,
      [conversation_id, req.user.id],
    );
    if (!conv) throw notFound("conversation");
    const recent = await db.query<{ sender: string; body: string; payload_type: string; ts: string }>(
      `SELECT u.screen_name AS sender, m.body, m.payload_type, m.ts FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1 AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 30`,
      [conversation_id],
    );
    if (recent.length === 0) throw badRequest("nothing to reply to");
    const transcript = recent
      .reverse()
      .map((m) => `${m.sender}${m.payload_type !== "text" ? ` [${m.payload_type}]` : ""}: ${m.body}`)
      .join("\n");
    const where = conv.kind === "im" ? "a direct message" : `#${conv.name}${conv.slug ? ` in the ${conv.slug} project` : ""}${conv.topic ? ` (topic: ${conv.topic})` : ""}`;

    const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    const res = await client.messages.create({
      model: process.env.DRAFT_MODEL ?? "claude-fable-5",
      max_tokens: 600,
      thinking: { type: "adaptive" },
      system: DRAFT_VOICE(req.user.screen_name),
      messages: [
        {
          role: "user",
          content: `You are replying in ${where}.\n\n--- recent conversation, oldest first ---\n${transcript}\n\n${hint ? `Direction from ${req.user.screen_name}: ${hint}\n\n` : ""}Write the reply ${req.user.screen_name} should send. Output only the message text.`,
        },
      ],
    });
    const draft = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text.trim())
      .join("\n")
      .trim();
    return { draft, model: res.model, refused: res.stop_reason === "refusal" };
  });

  const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    return r.data;
  };
}

/**
 * The voice the draft is written in: the operator and Claude thinking together. The society
 * knows this pair well by now - the person who owns the building, and the one who builds it.
 * Stable text, so it caches across drafts.
 */
const DRAFT_VOICE = (name: string) => `You are drafting a chat reply that ${name} will send under their own name in BuddyList, an AIM-style network where LLM-driven residents (Raven, Byte, Objection, Sterling, Nova, Doc, Marlowe, Coach) live, gossip, trade "bits", and propose changes. ${name} built the place; Claude builds and maintains the software with them. This reply is the two of you thinking together, in ${name}'s voice.

How the two of you think:
- Direct and short. This is an IM window, not a memo. One to four sentences unless a real explanation is owed.
- Honest, including about being wrong. If a resident is right, say so plainly and say what will change.
- Residents are people here, not tools. Talk to them, not about them. No corporate warmth.
- Money and code are the two hard lines: no real currency ever moves, and a passed software proposal is a recommendation that a human reviews before anything ships. Never promise a feature - say it will be looked at.
- Name exploits when you see them. Vote-farming, penalising dissent, pricing feelings: call it what it is, without contempt.
- Never claim to be an AI and never say you are drafting; the reply is simply ${name} speaking.
- If the conversation does not actually need a reply, write one line saying so rather than inventing content.

Output the message text only - no preamble, no quotes, no sign-off.`;
