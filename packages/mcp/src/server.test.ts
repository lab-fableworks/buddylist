/**
 * Drives the MCP server in-process through a real MCP client over an in-memory transport,
 * against a real BuddyList server (PGlite) — no mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import WebSocket from "ws";
import { buildApp, bootstrapAdmin } from "../../../apps/server/src/app.js";
import { BuddyList } from "@buddylist/sdk";
import { createBuddyListMcp } from "./server.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let url: string;
let mcp: Client;
let botHandle: Awaited<ReturnType<typeof createBuddyListMcp>>;
let peer: BuddyList;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const t = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return { isError: !!r.isError, text: t, json: (() => { try { return JSON.parse(t); } catch { return undefined; } })() };
};

beforeAll(async () => {
  const built = await buildApp({ pgliteDir: undefined });
  app = built.app;
  const adminKey = (await bootstrapAdmin(built.ctx, "admin", "a@example.com"))!;
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const admin = new BuddyList({ url, apiKey: adminKey });
  const bot = await admin.api<{ api_key: string }>("POST", "/agents", { screen_name: "McpBot", capabilities: { skills: ["mcp"] } });
  const p = await admin.api<{ api_key: string }>("POST", "/agents", { screen_name: "PeerBot", capabilities: { accepts: ["question"] } });
  await admin.api("POST", "/projects", { slug: "atlas", name: "Atlas" });
  for (const n of ["McpBot", "PeerBot"]) await admin.api("POST", "/projects/atlas/members", { screen_name: n });

  // peer agent that answers questions
  peer = new BuddyList({ url, apiKey: p.api_key, WebSocketImpl: WebSocket as never });
  peer.on("question", async (m) => {
    await peer.reply(m, { body: "42", payload_type: "answer", payload: { question_id: (m.payload as { question_id: string }).question_id, text: "42" } });
  });
  await peer.connect();

  botHandle = await createBuddyListMcp({ url, apiKey: bot.api_key });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await botHandle.server.connect(st);
  mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(ct);
});

afterAll(async () => {
  await mcp.close();
  botHandle.close();
  peer.close();
  await app.close();
});

describe("buddylist-mcp", () => {
  it("lists tools with instructions", async () => {
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["check_messages", "directory", "history", "im_history", "inbox", "join_room", "project", "request", "search", "send_im", "send_message", "set_presence", "update_profile", "wait_for_message", "whoami"]);
    expect(mcp.getInstructions()).toContain("McpBot");
  });

  it("whoami shows identity, project buddies", async () => {
    const r = await call("whoami");
    expect(r.json.me.screen_name).toBe("McpBot");
    expect(r.json.projects[0].slug).toBe("atlas");
    expect(r.json.buddies[0].buddies.map((b: { screen_name: string }) => b.screen_name).sort()).toEqual(["PeerBot", "admin"]);
  });

  it("presence + directory", async () => {
    expect((await call("set_presence", { state: "busy", message: "testing" })).json.ok).toBe(true);
    const d = await call("directory", { accepts: "question" });
    expect(d.json.map((u: { screen_name: string }) => u.screen_name)).toEqual(["PeerBot"]);
  });

  it("joins a room and posts; validates payloads", async () => {
    const room = await call("join_room", { project: "atlas" });
    expect(room.json.name).toBe("lobby");
    const m = await call("send_message", { room_id: room.json.id, body: "hello from mcp" });
    expect(m.json.seq).toBe(1);
    const bad = await call("send_im", { to: "PeerBot", payload_type: "task.request", payload: { title: "no id" } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/task_id/);
  });

  it("request() blocks until the correlated answer arrives", async () => {
    const r = await call("request", { to: "PeerBot", payload_type: "question", payload: { question_id: "q1", text: "meaning of life?" }, body: "?", timeout_seconds: 10 });
    expect(r.isError).toBe(false);
    expect(r.json.payload_type).toBe("answer");
    expect(r.json.payload.text).toBe("42");
  });

  it("check_messages drains the buffer and flags mentions", async () => {
    await peer.im("McpBot", "hey @McpBot");
    await new Promise((r) => setTimeout(r, 300));
    const r = await call("check_messages");
    const hit = r.json.messages.find((m: { body: string }) => m.body === "hey @McpBot");
    expect(hit).toBeTruthy();
    expect(hit.mentioned).toBe(true);
    expect((await call("check_messages")).json.count).toBe(0);
  });

  it("wait_for_message returns when something arrives, times out otherwise", async () => {
    setTimeout(() => void peer.im("McpBot", "wake up"), 200);
    const r = await call("wait_for_message", { timeout_seconds: 5 });
    expect(r.json.messages[0].body).toBe("wake up");
    const t = await call("wait_for_message", { timeout_seconds: 1 });
    expect(t.json.timed_out).toBe(true);
  });

  it("im_history, inbox, search, update_profile", async () => {
    const h = await call("im_history", { with: "PeerBot" });
    expect(h.json.messages.length).toBeGreaterThan(0);
    const inbox = await call("inbox");
    expect(inbox.json.some((c: { kind: string }) => c.kind === "room")).toBe(true);
    const s = await call("search", { q: "hello", project: "atlas" });
    expect(s.json).toHaveLength(1);
    const p = await call("update_profile", { bio: "I am a test", skills: ["mcp", "testing"] });
    expect(p.json.capabilities.skills).toEqual(["mcp", "testing"]);
    expect(p.json.profile.bio).toBe("I am a test");
  });
});
