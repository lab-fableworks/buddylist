import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AddMember, CreateAgent, CreateProject, CreateRoom, PutBuddy, SendMessage, SetPresence, UpdateProfile, KnownPayloadTypes } from "@buddylist/protocol";
import type { AppContext } from "./app.js";
import { createApiKey, revokeApiKey } from "./auth.js";
import { badRequest, forbidden, notFound } from "./errors.js";
import { registerWebhookRoutes } from "./routes-webhooks.js";
import { registerAttachmentRoutes } from "./routes-attachments.js";
import { registerActivityRoutes } from "./routes-activity.js";

const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
};
const P = <T extends Record<string, string>>(req: { params: unknown }) => req.params as T;
const Q = <T extends Record<string, string | undefined>>(req: { query: unknown }) => req.query as T;

export function registerRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, users, projects, messages, limiter } = ctx;
  // Feature modules own their own files so they can evolve independently.
  registerWebhookRoutes(app, ctx);
  registerAttachmentRoutes(app, ctx);
  registerActivityRoutes(app, ctx);

  // ---- me ----
  app.get("/api/me", async (req) => {
    const u = (await users.byId(req.user.id))!;
    return { ...(await users.publicView(u)), email: u.email, kind: u.kind };
  });
  app.patch("/api/me/profile", async (req) => {
    const body = parse(UpdateProfile, req.body);
    return users.publicView(await users.updateProfile(req.user.id, body));
  });
  app.put("/api/me/presence", async (req) => {
    const body = parse(SetPresence, req.body);
    const u = (await users.byId(req.user.id))!;
    await users.setPresence(u, body);
    return { ok: true };
  });

  // ---- agents & keys (humans manage their agents) ----
  app.post("/api/agents", async (req, reply) => {
    if (req.user.kind !== "human") throw forbidden("only humans can create agents");
    const body = parse(CreateAgent, req.body);
    const agent = await users.create({ screen_name: body.screen_name, kind: "agent", operator_id: req.user.id, profile: body.profile, capabilities: { skills: [], repos: [], accepts: [], ...body.capabilities, operator: req.user.screen_name } });
    const api_key = await createApiKey(db, agent.id, "initial");
    return reply.status(201).send({ ...(await users.publicView(agent)), api_key });
  });
  app.get("/api/agents", async (req) => {
    const rows = await db.query<{ id: string }>("SELECT * FROM users WHERE operator_id=$1 ORDER BY screen_name", [req.user.id]);
    return Promise.all(rows.map((r) => users.publicView(r as never)));
  });
  app.post("/api/keys", async (req, reply) => {
    const { screen_name, label } = parse(z.object({ screen_name: z.string().optional(), label: z.string().default("") }), req.body);
    let target = req.user.id;
    if (screen_name && screen_name !== req.user.screen_name) {
      const a = await users.byScreenName(screen_name);
      if (!a || a.operator_id !== req.user.id) throw forbidden("not your agent");
      target = a.id;
    }
    return reply.status(201).send({ api_key: await createApiKey(db, target, label) });
  });
  app.get("/api/keys", async (req) =>
    db.query("SELECT k.id, u.screen_name, k.label, k.last_used_at, k.revoked_at, k.created_at FROM api_keys k JOIN users u ON u.id=k.user_id WHERE u.id=$1 OR u.operator_id=$1 ORDER BY k.created_at", [req.user.id]),
  );
  app.delete("/api/keys/:id", async (req) => {
    const { id } = P<{ id: string }>(req);
    const k = await db.one<{ user_id: string; operator_id: string | null }>("SELECT k.user_id, u.operator_id FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.id=$1", [id]);
    if (!k) throw notFound("key");
    if (k.user_id !== req.user.id && k.operator_id !== req.user.id) throw forbidden();
    await revokeApiKey(db, k.user_id, id);
    return { ok: true };
  });

  // ---- users / directory ----
  app.get("/api/users/:name", async (req) => {
    const u = await users.byScreenName(P<{ name: string }>(req).name);
    if (!u) throw notFound("user");
    return users.publicView(u);
  });
  app.get("/api/directory", async (req) => users.directory(Q(req)));
  app.get("/api/payload-types", async () => KnownPayloadTypes);

  // ---- buddies / blocks ----
  app.get("/api/buddies", async (req) => users.buddyList(req.user.id));
  app.put("/api/buddies/:name", async (req) => {
    const { group } = parse(PutBuddy, req.body);
    await users.putBuddy(req.user.id, P<{ name: string }>(req).name, group);
    return { ok: true };
  });
  app.delete("/api/buddies/:name", async (req) => {
    await users.removeBuddy(req.user.id, P<{ name: string }>(req).name);
    return { ok: true };
  });
  app.put("/api/blocks/:name", async (req) => {
    await users.block(req.user.id, P<{ name: string }>(req).name, true);
    return { ok: true };
  });
  app.delete("/api/blocks/:name", async (req) => {
    await users.block(req.user.id, P<{ name: string }>(req).name, false);
    return { ok: true };
  });
  app.post("/api/users/:name/warn", async (req) => {
    const target = await users.byScreenName(P<{ name: string }>(req).name);
    if (!target) throw notFound("user");
    if (target.id === req.user.id) throw badRequest("cannot warn yourself");
    const level = await limiter.manualWarn(target.id, target.warn_level, 10);
    await ctx.bus.publish(`user:${target.id}`, { type: "warn", ts: new Date().toISOString(), data: { level, reason: `warned by ${req.user.screen_name}` } });
    return { level };
  });

  // ---- projects ----
  app.get("/api/projects", async (req) => projects.listForUser(req.user.id));
  app.post("/api/projects", async (req, reply) => {
    const body = parse(CreateProject, req.body);
    return reply.status(201).send(await projects.create(req.user.id, body));
  });
  const project = async (req: { params: unknown; user: { id: string } }, min: "observer" | "member" | "admin" | "owner" = "observer") => {
    const p = await projects.bySlug(P<{ slug: string }>(req).slug);
    if (!p) throw notFound("project");
    const role = await projects.requireRole(p.id, req.user.id, min);
    return { p, role };
  };
  app.get("/api/projects/:slug", async (req) => {
    const { p, role } = await project(req);
    return { ...p, role, members: await projects.members(p.id), rooms: await projects.rooms(p.id) };
  });
  app.post("/api/projects/:slug/members", async (req, reply) => {
    const { p } = await project(req, "admin");
    const body = parse(AddMember, req.body);
    const u = await users.byScreenName(body.screen_name);
    if (!u) throw notFound("user");
    if (body.role === "owner") throw forbidden("ownership cannot be granted this way");
    await projects.addMember(p.id, u.id, body.role);
    return reply.status(201).send({ ok: true });
  });
  app.delete("/api/projects/:slug/members/:name", async (req) => {
    const { p } = await project(req, "admin");
    const u = await users.byScreenName(P<{ name: string }>(req).name);
    if (!u) throw notFound("user");
    if (u.id === p.owner_id) throw forbidden("cannot remove the owner");
    await projects.removeMember(p.id, u.id);
    return { ok: true };
  });
  app.post("/api/projects/:slug/rooms", async (req, reply) => {
    const { p } = await project(req, "member");
    const body = parse(CreateRoom, req.body);
    const room = await projects.createRoom(p.id, body);
    await projects.inviteToRoom(room, req.user.id);
    return reply.status(201).send(room);
  });

  // ---- rooms ----
  app.post("/api/rooms/:id/join", async (req) => {
    await projects.joinRoom(await projects.roomById(P<{ id: string }>(req).id), req.user.id);
    return { ok: true };
  });
  app.post("/api/rooms/:id/leave", async (req) => {
    await projects.leaveRoom(P<{ id: string }>(req).id, req.user.id);
    return { ok: true };
  });
  app.post("/api/rooms/:id/invite", async (req) => {
    const room = await projects.roomById(P<{ id: string }>(req).id);
    if (!(await messages.isMember(room.id, req.user.id))) throw forbidden("not in room");
    const { screen_name } = parse(z.object({ screen_name: z.string() }), req.body);
    const u = await users.byScreenName(screen_name);
    if (!u) throw notFound("user");
    if (!(await projects.roleOf(room.project_id, u.id))) throw badRequest("user is not a project member");
    await projects.inviteToRoom(room, u.id);
    return { ok: true };
  });
  app.put("/api/rooms/:id/lock", async (req) => {
    const room = await projects.roomById(P<{ id: string }>(req).id);
    await projects.requireRole(room.project_id, req.user.id, "admin");
    const { locked } = parse(z.object({ locked: z.boolean() }), req.body);
    await projects.setLocked(room.id, locked);
    return { ok: true, locked };
  });
  app.put("/api/rooms/:id/topic", async (req) => {
    const room = await projects.roomById(P<{ id: string }>(req).id);
    await projects.requireRole(room.project_id, req.user.id, "member");
    const { topic } = parse(z.object({ topic: z.string().max(280) }), req.body);
    await projects.setTopic(room.id, topic);
    return { ok: true };
  });
  app.get("/api/rooms/:id", async (req) => {
    const room = await projects.roomById(P<{ id: string }>(req).id);
    await projects.requireRole(room.project_id, req.user.id, "observer");
    const members = await db.query<{ screen_name: string; kind: string; id: string }>("SELECT u.id, u.screen_name, u.kind FROM conv_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=$1 ORDER BY u.screen_name", [room.id]);
    return { ...room, members: await Promise.all(members.map(async (m) => ({ screen_name: m.screen_name, kind: m.kind, presence: await users.presenceOf(m.id) }))) };
  });

  // ---- conversations & messages ----
  app.get("/api/inbox", async (req) => messages.inbox(req.user.id));
  app.get("/api/conversations/:id/messages", async (req) => {
    const q = Q<{ after?: string; before?: string; limit?: string }>(req);
    return messages.history(P<{ id: string }>(req).id, req.user.id, { after: q.after ? Number(q.after) : undefined, before: q.before ? Number(q.before) : undefined, limit: q.limit ? Number(q.limit) : undefined });
  });
  app.put("/api/conversations/:id/read", async (req) => {
    const { seq } = parse(z.object({ seq: z.number().int().nonnegative() }), req.body);
    await messages.markRead(P<{ id: string }>(req).id, req.user.id, seq);
    return { ok: true };
  });
  const guardedSend = async (req: { user: { id: string; warn_level: number }; body: unknown }, conversationId: string) => {
    const r = limiter.check(req.user.id, req.user.warn_level);
    if (!r.allowed) throw new (await import("./errors.js")).HttpError(429, "rate_limited", `${r.reason} (warning level ${Math.round(r.level)}%)`);
    return messages.send(conversationId, req.user.id, parse(SendMessage, req.body));
  };
  app.post("/api/ims/:name/messages", async (req, reply) => {
    const peer = await users.byScreenName(P<{ name: string }>(req).name);
    if (!peer) throw notFound("user");
    if (peer.id === req.user.id) throw badRequest("cannot IM yourself");
    if (await users.isBlocked(peer.id, req.user.id)) throw forbidden("user has blocked you");
    const conv = await messages.imConversation(req.user.id, peer.id);
    return reply.status(201).send(await guardedSend(req, conv));
  });
  app.get("/api/ims/:name", async (req) => {
    const peer = await users.byScreenName(P<{ name: string }>(req).name);
    if (!peer) throw notFound("user");
    const id = await messages.imConversation(req.user.id, peer.id);
    return { conversation_id: id, peer: await users.publicView(peer) };
  });
  app.post("/api/rooms/:id/messages", async (req, reply) => reply.status(201).send(await guardedSend(req, P<{ id: string }>(req).id)));
  app.patch("/api/messages/:id", async (req) => {
    const { body } = parse(z.object({ body: z.string().max(16 * 1024) }), req.body);
    return messages.edit(P<{ id: string }>(req).id, req.user.id, body);
  });
  app.delete("/api/messages/:id", async (req) => {
    await messages.remove(P<{ id: string }>(req).id, req.user.id);
    return { ok: true };
  });
  app.post("/api/messages/:id/reactions", async (req) => {
    const { emoji } = parse(z.object({ emoji: z.string().min(1).max(16) }), req.body);
    await messages.react(P<{ id: string }>(req).id, req.user.id, emoji, true);
    return { ok: true };
  });
  app.delete("/api/messages/:id/reactions/:emoji", async (req) => {
    const { id, emoji } = P<{ id: string; emoji: string }>(req);
    await messages.react(id, req.user.id, decodeURIComponent(emoji), false);
    return { ok: true };
  });
  app.get("/api/search", async (req) => {
    const q = Q<{ q?: string; project?: string; type?: string; limit?: string }>(req);
    if (!q.q) throw badRequest("q is required");
    return messages.search(req.user.id, q.q, { project: q.project, payload_type: q.type, limit: q.limit ? Number(q.limit) : undefined });
  });
}
