import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp, bootstrapAdmin } from "./app.js";
import type { ServerFrame } from "@buddylist/protocol";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
let base: string;
let adminKey: string;

const api = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
};

function connect(key: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { authorization: `Bearer ${key}` } });
  const frames: ServerFrame[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  const waitFor = (pred: (f: ServerFrame) => boolean, ms = 3000) =>
    new Promise<ServerFrame>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error("timeout waiting for frame; got " + JSON.stringify(frames.map((f) => f.type)))), ms);
      ws.on("message", function h(d) {
        const f = JSON.parse(d.toString());
        if (pred(f)) {
          clearTimeout(t);
          ws.off("message", h);
          resolve(f);
        }
      });
    });
  return { ws, frames, waitFor, open: new Promise<void>((r) => ws.on("open", () => r())) };
}

beforeAll(async () => {
  ({ app, ctx } = await buildApp({ pgliteDir: undefined }));
  adminKey = (await bootstrapAdmin(ctx, "zgmcginn", "z@example.com"))!;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await app.close();
});

describe("BuddyList", () => {
  let botKey: string, reviewerKey: string, lobbyId: string;
  const projectSlug = "atlas";

  it("rejects unauthenticated requests", async () => {
    expect((await api("nope", "GET", "/api/me")).status).toBe(401);
  });

  it("human creates agents and gets keys", async () => {
    const r1 = await api(adminKey, "POST", "/api/agents", { screen_name: "CodeBot", capabilities: { skills: ["python"], accepts: ["task.request"] } });
    expect(r1.status).toBe(201);
    botKey = r1.json.api_key;
    expect(r1.json.uin).toBeGreaterThanOrEqual(100000);
    const r2 = await api(adminKey, "POST", "/api/agents", { screen_name: "ReviewBot", capabilities: { skills: ["code-review"], accepts: ["review.request"] } });
    reviewerKey = r2.json.api_key;
    const dup = await api(adminKey, "POST", "/api/agents", { screen_name: "codebot" });
    expect(dup.status).toBe(409);
    const me = await api(botKey, "GET", "/api/me");
    expect(me.json.screen_name).toBe("CodeBot");
    expect(me.json.capabilities.operator).toBe("zgmcginn");
  });

  it("directory search by skill/accepts", async () => {
    const r = await api(adminKey, "GET", "/api/directory?accepts=review.request");
    expect(r.json.map((u: { screen_name: string }) => u.screen_name)).toEqual(["ReviewBot"]);
  });

  it("creates a project with a lobby and members", async () => {
    const p = await api(adminKey, "POST", "/api/projects", { slug: projectSlug, name: "Atlas" });
    expect(p.status).toBe(201);
    expect((await api(adminKey, "POST", `/api/projects/${projectSlug}/members`, { screen_name: "CodeBot" })).status).toBe(201);
    expect((await api(adminKey, "POST", `/api/projects/${projectSlug}/members`, { screen_name: "ReviewBot", role: "observer" })).status).toBe(201);
    const view = await api(botKey, "GET", `/api/projects/${projectSlug}`);
    expect(view.json.rooms.map((r: { name: string }) => r.name)).toEqual(["lobby"]);
    lobbyId = view.json.rooms[0].id;
    expect(view.json.members).toHaveLength(3);
    // project peers appear on buddy list automatically
    const buddies = await api(botKey, "GET", "/api/buddies");
    expect(buddies.json[0].name).toBe("Project: Atlas");
    expect(buddies.json[0].buddies.map((b: { screen_name: string }) => b.screen_name).sort()).toEqual(["ReviewBot", "zgmcginn"]);
  });

  it("observers cannot post; members can; seq is monotonic", async () => {
    expect((await api(reviewerKey, "POST", `/api/rooms/${lobbyId}/messages`, { body: "hi" })).status).toBe(403);
    const m1 = await api(botKey, "POST", `/api/rooms/${lobbyId}/messages`, { body: "hello room" });
    const m2 = await api(adminKey, "POST", `/api/rooms/${lobbyId}/messages`, { body: "hey @CodeBot" });
    expect(m1.status).toBe(201);
    expect(m2.json.seq).toBe(m1.json.seq + 1);
    const hist = await api(reviewerKey, "GET", `/api/conversations/${lobbyId}/messages`);
    expect(hist.json.map((m: { body: string }) => m.body)).toEqual(["hello room", "hey @CodeBot"]);
  });

  it("validates structured payloads", async () => {
    const bad = await api(botKey, "POST", "/api/ims/ReviewBot/messages", { payload_type: "task.request", payload: { title: "x" } });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/task_id/);
    const unknown = await api(botKey, "POST", "/api/ims/ReviewBot/messages", { payload_type: "bogus", payload: {} });
    expect(unknown.status).toBe(400);
    const ok = await api(botKey, "POST", "/api/ims/ReviewBot/messages", { body: "please review", payload_type: "review.request", payload: { repo: "org/atlas", ref: "main" } });
    expect(ok.status).toBe(201);
    expect(ok.json.payload.focus).toEqual([]);
    const custom = await api(botKey, "POST", "/api/ims/ReviewBot/messages", { payload_type: "x-custom", payload: { anything: 1 } });
    expect(custom.status).toBe(201);
  });

  it("delivers IMs, presence, and mentions over WebSocket", async () => {
    const bot = connect(botKey);
    const rev = connect(reviewerKey);
    await Promise.all([bot.open, rev.open]);
    await bot.waitFor((f) => f.type === "welcome");
    await rev.waitFor((f) => f.type === "welcome");

    // presence: reviewer sees bot go online (project peer) — may have arrived before rev connected, so set explicitly
    bot.ws.send(JSON.stringify({ type: "presence.set", data: { state: "away", message: "running tests" } }));
    const pres = await rev.waitFor((f) => f.type === "presence" && f.data.screen_name === "CodeBot" && f.data.presence.state === "away");
    expect((pres as Extract<ServerFrame, { type: "presence" }>).data.presence.message).toBe("running tests");

    // IM delivered live
    await api(reviewerKey, "POST", "/api/ims/CodeBot/messages", { body: "pong" });
    const im = await bot.waitFor((f) => f.type === "message" && f.data.body === "pong");
    expect((im as Extract<ServerFrame, { type: "message" }>).data.sender).toBe("ReviewBot");

    // mention in room
    await api(adminKey, "POST", `/api/rooms/${lobbyId}/messages`, { body: "ping @ReviewBot" });
    await rev.waitFor((f) => f.type === "mention");

    // typing indicator
    const convId = (im as Extract<ServerFrame, { type: "message" }>).conversation_id;
    rev.ws.send(JSON.stringify({ type: "typing", conversation_id: convId }));
    await bot.waitFor((f) => f.type === "typing" && f.data.screen_name === "ReviewBot");

    // catch-up: reconnect with last_seq and get missed messages
    bot.ws.close();
    await new Promise((r) => bot.ws.on("close", r));
    await api(reviewerKey, "POST", "/api/ims/CodeBot/messages", { body: "missed me?" });
    const bot2 = connect(botKey);
    await bot2.open;
    await bot2.waitFor((f) => f.type === "welcome");
    bot2.ws.send(JSON.stringify({ type: "hello", last_seq: { [convId]: (im as Extract<ServerFrame, { type: "message" }>).seq } }));
    await bot2.waitFor((f) => f.type === "message" && f.data.body === "missed me?");

    // signoff event for watchers
    bot2.ws.close();
    await rev.waitFor((f) => f.type === "buddy.signoff" && f.data.screen_name === "CodeBot");
    rev.ws.close();
  });

  it("delivers the first message of a brand-new IM conversation live", async () => {
    const r3 = await api(adminKey, "POST", "/api/agents", { screen_name: "FreshBot" });
    const fresh = connect(r3.json.api_key);
    await fresh.open;
    await fresh.waitFor((f) => f.type === "welcome");
    await api(botKey, "POST", "/api/ims/FreshBot/messages", { body: "first contact" });
    await fresh.waitFor((f) => f.type === "message" && f.data.body === "first contact");
    fresh.ws.close();
  });

  it("returns 400 (not 500) for malformed ids", async () => {
    expect((await api(botKey, "POST", "/api/rooms/not-a-uuid/messages", { body: "x" })).status).toBe(400);
    expect((await api(botKey, "GET", "/api/conversations/nope/messages")).status).toBe(400);
    expect((await api(botKey, "DELETE", "/api/messages/nope")).status).toBe(400);
  });

  it("blocks prevent IMs", async () => {
    expect((await api(reviewerKey, "PUT", "/api/blocks/CodeBot")).status).toBe(200);
    expect((await api(botKey, "POST", "/api/ims/ReviewBot/messages", { body: "hi" })).status).toBe(403);
    await api(reviewerKey, "DELETE", "/api/blocks/CodeBot");
  });

  it("edits, deletes, reacts, searches", async () => {
    const m = await api(botKey, "POST", `/api/rooms/${lobbyId}/messages`, { body: "the quick brown fox" });
    expect((await api(adminKey, "PATCH", `/api/messages/${m.json.id}`, { body: "x" })).status).toBe(403);
    const e = await api(botKey, "PATCH", `/api/messages/${m.json.id}`, { body: "the quick brown cat" });
    expect(e.json.edited_at).toBeTruthy();
    expect((await api(adminKey, "POST", `/api/messages/${m.json.id}/reactions`, { emoji: "🔥" })).status).toBe(200);
    const s = await api(adminKey, "GET", "/api/search?q=cat&project=atlas");
    expect(s.json).toHaveLength(1);
    await api(botKey, "DELETE", `/api/messages/${m.json.id}`);
    expect((await api(adminKey, "GET", "/api/search?q=cat")).json).toHaveLength(0);
  });

  it("rate limits and raises warning level", async () => {
    let limited = 0;
    for (let i = 0; i < 30; i++) {
      const r = await api(botKey, "POST", `/api/rooms/${lobbyId}/messages`, { body: `spam ${i}` });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    const me = await api(botKey, "GET", "/api/me");
    expect(me.json.warn_level).toBeGreaterThan(0);
  });

  it("revokes keys", async () => {
    const keys = await api(adminKey, "GET", "/api/keys");
    const botKeyRow = keys.json.find((k: { screen_name: string }) => k.screen_name === "CodeBot");
    await api(adminKey, "DELETE", `/api/keys/${botKeyRow.id}`);
    expect((await api(botKey, "GET", "/api/me")).status).toBe(401);
  });
});
