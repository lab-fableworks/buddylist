import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { buildApp, bootstrapAdmin } from "./app.js";
import { webhooksService } from "./services/webhooks.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
let base: string;
let adminKey: string;
let fastWebhooks: ReturnType<typeof webhooksService>;

const api = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
};

/** Spins up a tiny local HTTP receiver that records every POST it gets. */
function startReceiver(handler: (req: http.IncomingMessage, body: string) => number) {
  const received: { headers: http.IncomingHttpHeaders; body: string; status: number }[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const status = handler(req, data);
      received.push({ headers: req.headers, body: data, status });
      res.writeHead(status).end();
    });
  });
  return new Promise<{ url: string; received: typeof received; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

beforeAll(async () => {
  ({ app, ctx } = await buildApp({ pgliteDir: undefined }));
  adminKey = (await bootstrapAdmin(ctx, "webhookadmin", "wh@example.com"))!;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  // app.ts already started ctx.webhooks with the default (slow) poll/backoff schedule.
  // Stop it and run our own fast-polling instance against the same db/bus for tests,
  // so retry/backoff scenarios complete quickly instead of taking hours.
  ctx.webhooks.stop();
  fastWebhooks = webhooksService(ctx.db, ctx.bus, ctx.users, {
    pollIntervalMs: 50,
    backoffMs: [80, 80, 80, 80, 80],
    requestTimeoutMs: 2000,
  });
  // Routes still call the original ctx.webhooks for CRUD (create/update/test all just write
  // rows to the shared db), but delivery is driven by this fast-polling instance so retry/backoff
  // scenarios finish in milliseconds instead of hours. Both instances share ctx.db and ctx.bus.
  fastWebhooks.start();
});
afterAll(async () => {
  fastWebhooks?.stop();
  await app.close();
});

describe("webhooks", () => {
  let agentKey: string;

  it("sets up an agent", async () => {
    const r = await api(adminKey, "POST", "/api/agents", { screen_name: "HookBot" });
    expect(r.status).toBe(201);
    agentKey = r.json.api_key;
  });

  it("creates a webhook, returns the secret only on create", async () => {
    const create = await api(agentKey, "POST", "/api/webhooks", { url: "http://127.0.0.1:1/nope", events: ["mention", "ping"] });
    expect(create.status).toBe(201);
    expect(create.json.secret).toBeTruthy();
    expect(create.json.url).toBe("http://127.0.0.1:1/nope");
    expect(create.json.events).toEqual(["mention", "ping"]);
    const id = create.json.id as string;

    const list = await api(agentKey, "GET", "/api/webhooks");
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(1);
    expect(list.json[0].secret).toBeUndefined();
    expect(list.json[0].id).toBe(id);

    const del = await api(agentKey, "DELETE", `/api/webhooks/${id}`);
    expect(del.status).toBe(200);
    expect((await api(agentKey, "GET", "/api/webhooks")).json).toHaveLength(0);
  });

  it("404s deleting/patching another user's webhook", async () => {
    const other = await api(adminKey, "POST", "/api/agents", { screen_name: "OtherBot" });
    const otherKey = other.json.api_key;
    const create = await api(otherKey, "POST", "/api/webhooks", { url: "http://127.0.0.1:1/x", events: ["ping"] });
    const id = create.json.id as string;
    expect((await api(agentKey, "DELETE", `/api/webhooks/${id}`)).status).toBe(404);
    expect((await api(agentKey, "PATCH", `/api/webhooks/${id}`, { active: false })).status).toBe(404);
    await api(otherKey, "DELETE", `/api/webhooks/${id}`);
  });

  it("validates url and events on create", async () => {
    expect((await api(agentKey, "POST", "/api/webhooks", { url: "ftp://nope", events: ["ping"] })).status).toBe(400);
    expect((await api(agentKey, "POST", "/api/webhooks", { url: "http://x/y", events: ["bogus"] })).status).toBe(400);
    expect((await api(agentKey, "POST", "/api/webhooks", { url: "http://x/y", events: [] })).status).toBe(400);
  });

  it("delivers a ping via POST /test with a verified HMAC signature", async () => {
    const recv = await startReceiver(() => 200);
    const create = await api(agentKey, "POST", "/api/webhooks", { url: recv.url, events: ["ping"] });
    const id = create.json.id as string;
    const secret = create.json.secret as string;

    const t = await api(agentKey, "POST", `/api/webhooks/${id}/test`);
    expect(t.status).toBe(202);

    await vi_waitFor(() => recv.received.length >= 1, 3000);
    const hit = recv.received[0];
    expect(hit.headers["x-buddylist-event"]).toBe("ping");
    expect(hit.headers["x-buddylist-delivery"]).toBeTruthy();
    const ts = hit.headers["x-buddylist-timestamp"] as string;
    const sig = hit.headers["x-buddylist-signature"] as string;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${hit.body}`).digest("hex");
    expect(sig).toBe(expected);

    const deliveries = await api(agentKey, "GET", `/api/webhooks/${id}/deliveries`);
    expect(deliveries.json[0].status).toBe("delivered");
    expect(deliveries.json[0].attempts).toBe(1);

    await recv.close();
    await api(agentKey, "DELETE", `/api/webhooks/${id}`);
  });

  it("retries on failure and eventually marks failed after 5 attempts", async () => {
    const recv = await startReceiver(() => 500);
    const create = await api(agentKey, "POST", "/api/webhooks", { url: recv.url, events: ["ping"] });
    const id = create.json.id as string;
    await api(agentKey, "POST", `/api/webhooks/${id}/test`);

    await vi_waitFor(async () => {
      const d = await api(agentKey, "GET", `/api/webhooks/${id}/deliveries`);
      return d.json[0]?.status === "failed";
    }, 8000);

    const d = await api(agentKey, "GET", `/api/webhooks/${id}/deliveries`);
    expect(d.json[0].status).toBe("failed");
    expect(d.json[0].attempts).toBe(5);
    expect(d.json[0].last_status).toBe(500);
    expect(recv.received.length).toBe(5);

    await recv.close();
    await api(agentKey, "DELETE", `/api/webhooks/${id}`);
  }, 15000);

  it("delivers mention events end-to-end and skips non-subscribed events", async () => {
    const recv = await startReceiver(() => 200);
    // Subscribed only to "mention", not "room.message" — room messages should never arrive
    // (room.message emission is not wired to the bus in this workstream; see report).
    const create = await api(agentKey, "POST", "/api/webhooks", { url: recv.url, events: ["mention"] });
    const id = create.json.id as string;

    const project = await api(adminKey, "POST", "/api/projects", { slug: "hookproj", name: "HookProj" });
    expect(project.status).toBe(201);
    await api(adminKey, "POST", "/api/projects/hookproj/members", { screen_name: "HookBot" });
    const view = await api(agentKey, "GET", "/api/projects/hookproj");
    const roomId = view.json.rooms[0].id;

    await api(adminKey, "POST", `/api/rooms/${roomId}/messages`, { body: "hey @HookBot check this out" });

    await vi_waitFor(() => recv.received.length >= 1, 3000);
    expect(recv.received).toHaveLength(1);
    expect(recv.received[0].headers["x-buddylist-event"]).toBe("mention");
    const payload = JSON.parse(recv.received[0].body);
    expect(payload.from).toBe("webhookadmin");

    // give the (non-)delivery of a disallowed event a moment, then confirm nothing else showed up
    await new Promise((r) => setTimeout(r, 150));
    expect(recv.received).toHaveLength(1);

    await recv.close();
    await api(agentKey, "DELETE", `/api/webhooks/${id}`);
  });

  it("does not deliver to inactive webhooks", async () => {
    const recv = await startReceiver(() => 200);
    const create = await api(agentKey, "POST", "/api/webhooks", { url: recv.url, events: ["ping"] });
    const id = create.json.id as string;
    await api(agentKey, "PATCH", `/api/webhooks/${id}`, { active: false });
    await api(agentKey, "POST", `/api/webhooks/${id}/test`);
    await new Promise((r) => setTimeout(r, 200));
    expect(recv.received).toHaveLength(0);
    await recv.close();
    await api(agentKey, "DELETE", `/api/webhooks/${id}`);
  });
});

async function vi_waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}
