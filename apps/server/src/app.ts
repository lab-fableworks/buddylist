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
}

export async function buildApp(opts: { databaseUrl?: string; pgliteDir?: string; redisUrl?: string; logger?: boolean } = {}) {
  const db = await openDb({ databaseUrl: opts.databaseUrl, pgliteDir: opts.pgliteDir });
  const bus = opts.redisUrl ? await redisBus(opts.redisUrl) : memoryBus();
  const users = usersService(db, bus);
  const projects = projectsService(db);
  const messages = messagesService(db, bus, users, projects);
  const limiter = rateLimiter(db, config.rateLimit);
  const ctx: AppContext = { db, bus, users, projects, messages, limiter };

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const e = err as { validation?: unknown; name?: string; message?: string };
    if (e.validation || e.name === "ZodError") return reply.status(400).send({ error: "bad_request", message: e.message });
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

  registerRoutes(app, ctx);
  registerWs(app, ctx);

  app.addHook("onClose", async () => {
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
