/**
 * Tiny HTTP surface for the agent runner.
 *
 * Without this the machine has no service for Fly to watch, so a runner that silently loses
 * its sockets looks "started" forever and Fly never restarts it. The health check reports
 * unhealthy when no agent is actually signed on, which is the condition that matters.
 */
import { createServer, type Server } from "node:http";

export interface AgentHealth {
  screen_name: string;
  connected: () => boolean;
  lastActivity: () => string | undefined;
}

export function startHealthServer(port: number, agents: AgentHealth[], meta: { url: string; project: string }, society?: () => unknown): Server {
  const started = Date.now();

  const snapshot = () => {
    const list = agents.map((a) => ({ screen_name: a.screen_name, connected: a.connected(), activity: a.lastActivity() ?? null }));
    const connected = list.filter((a) => a.connected).length;
    return {
      ok: connected > 0,
      connected,
      expected: agents.length,
      uptime_seconds: Math.round((Date.now() - started) / 1000),
      server: meta.url,
      project: meta.project,
      agents: list,
      society: society?.() ?? null,
    };
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz" || path === "/status" || path === "/") {
      const body = snapshot();
      // 503 when nothing is signed on so Fly restarts the machine instead of leaving
      // a process that is up but useless.
      res.writeHead(body.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.listen(port, "0.0.0.0");
  return server;
}
