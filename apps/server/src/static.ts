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
  // index:false so the plugin does not claim GET "/" — which host to serve there depends on
  // the hostname, so we own that route ourselves.
  //
  // Cache policy: hashed assets are immutable (the hash IS the version), HTML is always
  // revalidated. This is also the defence against rolling deploys on more than one machine:
  // once a browser has an asset it never re-fetches it, so it cannot catch a machine that is
  // mid-deploy and missing the file.
  await app.register(fastifyStatic, { root, wildcard: false, index: false, cacheControl: false });

  // Cache policy, applied where it cannot be missed rather than through plugin callbacks:
  // hashed assets are immutable (the hash IS the version), HTML always revalidates. This is
  // also the defence against rolling deploys on more than one machine — once a browser has an
  // asset it never re-fetches it, so it cannot catch a machine that is mid-deploy.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/assets/")) {
      if (reply.statusCode === 200) reply.header("cache-control", "public, max-age=31536000, immutable");
    } else if (String(reply.getHeader("content-type") ?? "").includes("text/html")) {
      reply.header("cache-control", "no-cache");
    }
    return payload;
  });

  // SPA fallback: unknown non-API paths return index.html so client routing works,
  // while /api and /ws keep their real 404s (a JSON 404 is far easier to debug than
  // silently receiving an HTML page from an API call).
  // The dashboard gets its own hostname. Fly allows several certs on one app and they all
  // resolve to the same IPs, so host-based routing avoids standing up a second app entirely.
  const dashboardHosts = (process.env.DASHBOARD_HOSTS ?? "stats.,dash.,ops.")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const wantsDashboard = (req: { hostname?: string; headers: Record<string, unknown>; url: string }) => {
    if (req.url.startsWith("/stream")) return false;
    if (req.url.startsWith("/dashboard")) return true;
    const host = String(req.hostname ?? req.headers.host ?? "").toLowerCase();
    return dashboardHosts.some((prefix) => host.startsWith(prefix));
  };

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws") || req.url.startsWith("/healthz"))
      return reply.status(404).send({ error: "not_found", message: `no route for ${req.method} ${req.url}` });
    // A missing asset must be a real 404, never the SPA page. Serving HTML with a 200 here is
    // how a blank screen happens: the module loader receives text/html, refuses it, and the
    // page dies silently — seen in production when two machines briefly ran different builds.
    if (req.url.startsWith("/assets/"))
      return reply.status(404).header("cache-control", "no-store").send({ error: "not_found", message: "no such asset in this build" });
    return reply.header("cache-control", "no-cache").sendFile(wantsDashboard(req) ? "dashboard.html" : "index.html");
  });

  // Root is host-dependent: the retro client on the main host, the dashboard on its own.
  app.get("/", async (req, reply) => reply.header("cache-control", "no-cache").sendFile(wantsDashboard(req) ? "dashboard.html" : "index.html"));
  app.get("/dashboard", async (_req, reply) => reply.header("cache-control", "no-cache").sendFile("dashboard.html"));
  // The overlay. Its own path so it can be an OBS browser source without a sign-in.
  app.get("/stream", async (_req, reply) => reply.header("cache-control", "no-cache").sendFile("stream.html"));
  app.log.info(`serving web client from ${root}`);
  return true;
}
