/**
 * Serves the built web client from the same origin as the API and WebSocket.
 *
 * Single-origin matters: the client defaults to `window.location.origin`, so there is no CORS
 * to configure, no second hostname, and the browser sends the session to `/ws` without a
 * cross-origin upgrade. One CNAME points at this server and everything works.
 *
 * No-op when the build directory is absent (normal in dev, where Vite serves the client).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

export async function registerStatic(app: FastifyInstance, dir?: string) {
  const root = resolve(dir ?? "apps/web/dist");
  if (!existsSync(root)) {
    app.log.info(`no web build at ${root} — serving API only`);
    return false;
  }
  const { default: fastifyStatic } = await import("@fastify/static");
  await app.register(fastifyStatic, { root, wildcard: false });

  // SPA fallback: unknown non-API paths return index.html so client routing works,
  // while /api and /ws keep their real 404s (a JSON 404 is far easier to debug than
  // silently receiving an HTML page from an API call).
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws") || req.url.startsWith("/healthz"))
      return reply.status(404).send({ error: "not_found", message: `no route for ${req.method} ${req.url}` });
    return reply.sendFile("index.html");
  });
  app.log.info(`serving web client from ${root}`);
  return true;
}
