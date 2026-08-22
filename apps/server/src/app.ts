import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { openDb, type Db } from "./db.js";
import { memoryBus, redisBus, type Bus } from "./bus.js";
import { usersService } from "./services/users.js";
import { projectsService } from "./services/projects.js";
import { messagesService } from "./services/messages.js";
import { rateLimiter } from "./ratelimit.js";
import { HttpError } from "./errors.js";
import { authenticate, bearer, createApiKey, type AuthUser } from "./auth.js";
import { registerRoutes } from "./routes.js";
import { openStorage, type Storage } from "./storage.js";
import { webhooksService, type WebhooksService } from "./services/webhooks.js";
import { attachmentsService, type AttachmentsService } from "./services/attachments.js";
import { activityService, type ActivityService } from "./services/activity.js";
import { registerWs } from "./ws.js";
import { config } from "./config.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
  }
}

export interface AppContext {
  db: Db;
  bus: Bus;
  users: ReturnType<typeof usersService>;
  projects: ReturnType<typeof projectsService>;
  messages: ReturnType<typeof messagesService>;
  limiter: ReturnType<typeof rateLimiter>;
  storage: Storage;
  webhooks: WebhooksService;
  attachments: AttachmentsService;
  activity: ActivityService;
}

export async function buildApp(opts: { databaseUrl?: string; pgliteDir?: string; redisUrl?: string; storageDir?: string; logger?: boolean } = {}) {
  const db = await openDb({ databaseUrl: opts.databaseUrl, pgliteDir: opts.pgliteDir });
  const bus = opts.redisUrl ? await redisBus(opts.redisUrl) : memoryBus();
  const users = usersService(db, bus);
  const projects = projectsService(db, bus);
  const limiter = rateLimiter(db, config.rateLimit);
  const storage = await openStorage({ dir: opts.storageDir });
  const webhooks = webhooksService(db, bus, users);
  const messages = messagesService(db, bus, users, projects, webhooks);
  const attachments = attachmentsService(db, storage);
  const activity = activityService(db, bus, users);
  const ctx: AppContext = { db, bus, users, projects, messages, limiter, storage, webhooks, attachments, activity };

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const e = err as { validation?: unknown; name?: string; message?: string };
    if (e.validation || e.name === "ZodError") return reply.status(400).send({ error: "bad_request", message: e.message });
    // Postgres 22P02 invalid_text_representation — almost always a malformed UUID in a path param.
    if ((err as { code?: string }).code === "22P02" || /invalid input syntax for type uuid/.test(e.message ?? ""))
      return reply.status(400).send({ error: "bad_request", message: "malformed id" });
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "internal error" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  // auth hook for everything under /api
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const user = await authenticate(db, bearer(req.headers.authorization) ?? (req.query as { key?: string }).key);
    if (!user) return reply.status(401).send({ error: "unauthorized", message: "missing or invalid API key" });
    req.user = user;
  });

  // Presence changes reach webhook subscribers who watch this user.
  users.setPresenceSink((userId, screenName, presence) => {
    // Fire-and-forget: a socket closing during shutdown triggers a presence change, and the
    // lookup below must not reject after the DB has closed. Best-effort, like the other
    // teardown-time writes.
    void users
      .watchersOf(userId)
      .then((ws) => {
        for (const w of ws) void webhooks.emit(w, "buddy.presence", { screen_name: screenName, presence });
      })
      .catch(() => {});
  });
  webhooks.start();
  registerRoutes(app, ctx);
  registerWs(app, ctx);

  app.addHook("onClose", async () => {
    webhooks.stop();
    await bus.close();
    await db.close();
  });

  return { app, ctx };
}

/** Creates the bootstrap human admin on first boot and returns their API key (once). */
export async function bootstrapAdmin(ctx: AppContext, screenName: string, email: string): Promise<string | undefined> {
  const existing = await ctx.users.byScreenName(screenName);
  if (existing) return undefined;
  const u = await ctx.users.create({ screen_name: screenName, kind: "human", email });
  return createApiKey(ctx.db, u.id, "bootstrap");
}
