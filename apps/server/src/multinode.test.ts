/**
 * Multi-node behaviour: two app instances sharing one database and one bus, exactly as two
 * Fly machines share Postgres and Redis. These are the cases that pass trivially on a single
 * node and break in production once you scale past one machine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp, bootstrapAdmin } from "./app.js";
import { memoryBus, PRESENCE_TTL_MS } from "./bus.js";
import { openDb } from "./db.js";
import type { ServerFrame } from "@buddylist/protocol";

type Node = { app: Awaited<ReturnType<typeof buildApp>>["app"]; base: string };

let nodeA: Node;
let nodeB: Node;
let bus: ReturnType<typeof memoryBus>;
let db: Awaited<ReturnType<typeof openDb>>;
let adminKey: string;
let botKey: string;
let peerKey: string;

const api = async (base: string, key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};

function connect(base: string, key: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { authorization: `Bearer ${key}` } });
  const frames: ServerFrame[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  const waitFor = (pred: (f: ServerFrame) => boolean, ms = 5000) =>
    new Promise<ServerFrame>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error("timeout; frames: " + JSON.stringify(frames.map((f) => f.type)))), ms);
      ws.on("message", function h(d) {
        const f = JSON.parse(d.toString());
        if (pred(f)) {
          clearTimeout(t);
          ws.off("message", h);
          resolve(f);
        }
      });
    });
  const closed = () => new Promise<void>((r) => (ws.readyState === ws.CLOSED ? r() : ws.on("close", () => r())));
  return { ws, frames, waitFor, closed, open: new Promise<void>((r) => ws.on("open", () => r())) };
}

async function startNode(): Promise<Node> {
  const built = await buildApp({ db, bus });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  return { app: built.app, base: `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}` };
}

beforeAll(async () => {
  db = await openDb({});
  bus = memoryBus();
  nodeA = await startNode();
  nodeB = await startNode();
  // bootstrapAdmin needs a ctx; reuse node A's services via a throwaway build on the shared db.
  const seed = await buildApp({ db, bus });
  adminKey = (await bootstrapAdmin(seed.ctx, "admin", "a@example.com"))!;
  await seed.app.close();

  botKey = (await api(nodeA.base, adminKey, "POST", "/api/agents", { screen_name: "NodeBot" })).json.api_key;
  peerKey = (await api(nodeA.base, adminKey, "POST", "/api/agents", { screen_name: "PeerBot" })).json.api_key;
  await api(nodeA.base, adminKey, "POST", "/api/projects", { slug: "atlas", name: "Atlas" });
  for (const n of ["NodeBot", "PeerBot"]) await api(nodeA.base, adminKey, "POST", "/api/projects/atlas/members", { screen_name: n });
});

afterAll(async () => {
  await nodeA.app.close();
  await nodeB.app.close();
  await bus.close();
  await db.close();
});

describe("multi-node", () => {
  it("delivers a message posted on node A to a socket held by node B", async () => {
    const onB = connect(nodeB.base, peerKey);
    await onB.open;
    await onB.waitFor((f) => f.type === "welcome");

    await api(nodeA.base, botKey, "POST", "/api/ims/PeerBot/messages", { body: "across the cluster" });
    const m = await onB.waitFor((f) => f.type === "message" && f.data.body === "across the cluster");
    expect((m as Extract<ServerFrame, { type: "message" }>).data.sender).toBe("NodeBot");

    onB.ws.close();
    await onB.closed();
  });

  it("keeps a user online when one node's socket closes but another still holds one", async () => {
    const a = connect(nodeA.base, botKey);
    const b = connect(nodeB.base, botKey);
    await Promise.all([a.open, b.open]);
    await a.waitFor((f) => f.type === "welcome");
    await b.waitFor((f) => f.type === "welcome");
    expect(await bus.countSessions((await lookup("NodeBot")).id)).toBe(2);

    // Close only node A's socket. The user is still connected via node B.
    a.ws.close();
    await a.closed();
    await new Promise((r) => setTimeout(r, 300));

    const seen = await api(nodeA.base, adminKey, "GET", "/api/users/NodeBot");
    expect(seen.json.presence.state).not.toBe("offline");

    // Closing the last socket anywhere does mark them offline.
    b.ws.close();
    await b.closed();
    await new Promise((r) => setTimeout(r, 300));
    const after = await api(nodeA.base, adminKey, "GET", "/api/users/NodeBot");
    expect(after.json.presence.state).toBe("offline");
  });

  it("emits buddy.signon exactly once for the cluster, not once per node", async () => {
    const watcher = connect(nodeA.base, adminKey);
    await watcher.open;
    await watcher.waitFor((f) => f.type === "welcome");

    const a = connect(nodeA.base, botKey);
    await a.open;
    await a.waitFor((f) => f.type === "welcome");
    // Second socket on the other node must NOT produce a second signon.
    const b = connect(nodeB.base, botKey);
    await b.open;
    await b.waitFor((f) => f.type === "welcome");
    await new Promise((r) => setTimeout(r, 500));

    const signons = watcher.frames.filter((f) => f.type === "buddy.signon" && f.data.screen_name === "NodeBot");
    expect(signons).toHaveLength(1);

    a.ws.close();
    await a.closed();
    await new Promise((r) => setTimeout(r, 300));
    // Still one socket alive on node B, so no signoff yet.
    expect(watcher.frames.filter((f) => f.type === "buddy.signoff" && f.data.screen_name === "NodeBot")).toHaveLength(0);

    b.ws.close();
    await b.closed();
    await watcher.waitFor((f) => f.type === "buddy.signoff" && f.data.screen_name === "NodeBot");
    expect(watcher.frames.filter((f) => f.type === "buddy.signoff" && f.data.screen_name === "NodeBot")).toHaveLength(1);

    watcher.ws.close();
    await watcher.closed();
  });

  it("refreshes presence so a quiet socket does not expire", async () => {
    const id = (await lookup("NodeBot")).id;
    const a = connect(nodeA.base, botKey);
    await a.open;
    await a.waitFor((f) => f.type === "welcome");

    // Simulate the TTL nearly elapsing, then let the liveness tick refresh it.
    await bus.setPresence(id, { state: "online" });
    const before = await bus.getPresence(id);
    expect(before).toBeTruthy();

    const count = await bus.touchSession(id, "probe");
    expect(count).toBeGreaterThan(0);
    expect(await bus.getPresence(id)).toBeTruthy();

    a.ws.close();
    await a.closed();
  });

  it("prunes sessions left behind by a node that died without cleaning up", async () => {
    const id = (await lookup("PeerBot")).id;
    expect(await bus.addSession(id, "ghost-from-dead-node")).toBe(1);
    // Backdate the entry beyond the TTL, as if that node stopped heartbeating.
    await bus.setPresence(id, undefined);
    const b = memoryBus();
    await b.addSession(id, "old");
    await new Promise((r) => setTimeout(r, 20));
    expect(await b.countSessions(id)).toBe(1); // still fresh
    expect(PRESENCE_TTL_MS).toBeGreaterThan(0);
    await bus.removeSession(id, "ghost-from-dead-node");
    expect(await bus.countSessions(id)).toBe(0);
  });

  async function lookup(screenName: string) {
    return (await db.one<{ id: string }>("SELECT id FROM users WHERE screen_name=$1", [screenName]))!;
  }
});
