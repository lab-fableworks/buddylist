/**
 * The "what needs me" queue.
 *
 * The rules worth pinning down are the ones that decide whether something leaves the queue:
 * reading is not answering, a room broadcast is not addressed to you, and @Doc must not match
 * @Docker. Get those wrong and the queue either nags about settled things or hides real ones.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, bootstrapAdmin } from "./app.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let base: string;
let meKey: string;
let botKey: string;
let docKey: string;
let roomId: string;
let imId: string;

const api = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};
const attention = async (qs = "") => (await api(meKey, "GET", "/api/attention" + qs)).json;
const say = (key: string, conv: string, body: string, payload_type = "text", payload = {}) =>
  api(key, "POST", `/api/rooms/${conv}/messages`, { body, payload_type, payload });

let savedKey: string | undefined;
beforeAll(async () => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const built = await buildApp({ pgliteDir: undefined });
  app = built.app;
  meKey = (await bootstrapAdmin(built.ctx, "zgmcginn", "z@example.com"))!;
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  botKey = (await api(meKey, "POST", "/api/agents", { screen_name: "Byte" })).json.api_key;
  docKey = (await api(meKey, "POST", "/api/agents", { screen_name: "Docker" })).json.api_key;
  await api(meKey, "POST", "/api/projects", { slug: "society", name: "Society" });
  for (const n of ["Byte", "Docker"]) await api(meKey, "POST", "/api/projects/society/members", { screen_name: n });
  roomId = (await api(meKey, "POST", "/api/projects/society/rooms", { name: "commons", topic: "t" })).json.id;
  for (const k of [botKey, docKey]) await api(k, "POST", `/api/rooms/${roomId}/join`);
  imId = (await api(botKey, "GET", "/api/ims/zgmcginn")).json.conversation_id;
});
afterAll(async () => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  await app.close();
});

describe("attention", () => {
  it("is empty when nobody has asked for anything", async () => {
    const a = await attention();
    expect(a.total).toBe(0);
    expect(a.items).toEqual([]);
  });

  it("does not treat a longer name that starts with yours as a mention of you", async () => {
    // The naive pattern is /@name/ with no boundary, which makes every "@zgmcginn_bot" a
    // mention of zgmcginn - and, in the society, every "@Docker" a mention of Doc.
    await say(botKey, roomId, "@zgmcginn_bot can you take this one?");
    expect((await attention()).items).toEqual([]);
    await say(botKey, roomId, "@Docker are you up?");
    expect((await attention()).items).toEqual([]);
  });

  it("surfaces a room mention, and keeps it until answered rather than until read", async () => {
    await say(botKey, roomId, "@zgmcginn what do you make of Sterling's proposal?");
    let a = await attention();
    expect(a.total).toBe(1);
    expect(a.items[0].reason).toBe("mention");
    expect(a.items[0].unread).toBe(1);
    expect(a.items[0].room).toBe("commons");
    expect(a.items[0].project).toBe("society");

    // Reading it clears the unread flag but not the obligation.
    await api(meKey, "PUT", `/api/conversations/${roomId}/read`, { seq: a.items[0].latest.seq });
    a = await attention();
    expect(a.total).toBe(1);
    expect(a.items[0].unread).toBe(0);

    // Replying clears it.
    await say(meKey, roomId, "I think it penalises dissent.");
    expect((await attention()).total).toBe(0);
    // ...but it is still findable, marked answered, when explicitly asked for.
    const all = await attention("?all=1");
    expect(all.items[0].answered).toBe(true);
  });

  it("collapses a thread to one item you owe a reply to, not one per message", async () => {
    for (const t of ["you around?", "when you get a sec", "still there?"]) await say(botKey, imId, t);
    const a = await attention();
    expect(a.total).toBe(1);
    expect(a.items[0].reason).toBe("dm");
    expect(a.items[0].triggers).toBe(3);
    expect(a.items[0].unread).toBe(3);
    expect(a.items[0].peer).toBe("Byte");
    expect(a.items[0].latest.body).toBe("still there?");
  });

  it("ranks a direct question above chatter, and ignores a room broadcast not aimed at you", async () => {
    // Broadcast to the room: real work, but not addressed to anyone in particular.
    await say(docKey, roomId, "picking up the export job", "task.request", { task_id: "t-1", title: "Export" });
    await say(botKey, imId, "quick one", "question", { question_id: "q-1", text: "quick one" });
    const a = await attention();
    const reasons = a.items.map((i: { reason: string }) => i.reason);
    expect(reasons[0]).toBe("question");
    expect(reasons).not.toContain("task.request");
    // The IM now triggers two ways; the more demanding one wins and it stays a single item.
    const im = a.items.find((i: { conversation_id: string }) => i.conversation_id === imId);
    expect(im.reason).toBe("question");
    expect(im.reasons).toEqual(expect.arrayContaining(["question", "dm"]));
  });

  it("counts a task addressed to you directly", async () => {
    await say(docKey, roomId, "@zgmcginn please review", "task.request", { task_id: "t-2", title: "Review" });
    const a = await attention();
    expect(a.by_reason["task.request"]).toBe(1);
  });

  it("matches a mention in any case, because the notification path does", async () => {
    // users are looked up by screen_name_lc, so "@ZGMcginn" already fires a live mention.
    // A case-sensitive queue would quietly drop those.
    // Its own room, so an earlier test's stronger trigger cannot mask the result.
    const quiet = (await api(meKey, "POST", "/api/projects/society/rooms", { name: "quiet", topic: "t" })).json.id;
    await api(botKey, "POST", `/api/rooms/${quiet}/join`);
    await say(botKey, quiet, "@ZGMcginn one more thing");
    const item = (await attention()).items.find((i: { conversation_id: string }) => i.conversation_id === quiet);
    expect(item.reason).toBe("mention");
  });

  it("dismiss hides a conversation until someone says something new", async () => {
    const room = (await api(meKey, "POST", "/api/projects/society/rooms", { name: "dismissable", topic: "t" })).json.id;
    await api(botKey, "POST", `/api/rooms/${room}/join`);
    await say(botKey, room, "@zgmcginn thoughts?");
    const before = (await attention()).items.find((i: { conversation_id: string }) => i.conversation_id === room);
    expect(before).toBeTruthy();

    expect((await api(meKey, "POST", "/api/attention/dismiss", { conversation_id: room, seq: before.latest.seq })).status).toBe(200);
    expect((await attention()).items.find((i: { conversation_id: string }) => i.conversation_id === room)).toBeUndefined();
    // Still visible when asked for, and distinguishable from answered: you did not reply, you chose not to.
    const shown = (await attention("?all=1")).items.find((i: { conversation_id: string }) => i.conversation_id === room);
    expect(shown.dismissed).toBe(true);
    expect(shown.answered).toBe(false);

    // Dismiss means "handled for now", not "mute": a new mention brings it straight back.
    await say(botKey, room, "@zgmcginn sorry, one more");
    const again = (await attention()).items.find((i: { conversation_id: string }) => i.conversation_id === room);
    expect(again).toBeTruthy();
    expect(again.dismissed).toBe(false);
    expect(again.triggers).toBe(1);

    // And it can be taken back.
    await api(meKey, "DELETE", `/api/attention/dismiss/${room}`);
    expect((await attention()).items.find((i: { conversation_id: string }) => i.conversation_id === room).triggers).toBe(2);
  });

  it("accepts seq as the string Postgres hands the client", async () => {
    // PGlite returns BIGINT as a number, so the fixture cannot reproduce the production shape
    // by accident; send exactly what a browser on Postgres sends.
    const r = await api(meKey, "POST", "/api/attention/dismiss", { conversation_id: imId, seq: "1" });
    expect(r.status).toBe(200);
    await api(meKey, "DELETE", `/api/attention/dismiss/${imId}`);
  });

  it("refuses to dismiss a conversation you are not in", async () => {
    const priv = (await api(botKey, "GET", "/api/ims/Docker")).json.conversation_id;
    expect((await api(meKey, "POST", "/api/attention/dismiss", { conversation_id: priv, seq: 1 })).status).toBe(403);
  });

  it("drafts are for humans, and fail loudly when the server has no key", async () => {
    // An agent asking for a draft is an agent asking to be a different agent.
    expect((await api(botKey, "POST", `/api/attention/${imId}/draft`, {})).status).toBe(403);
    // Unconfigured is a 503, not a 500 - the operator should know it is setup, not a crash.
    const r = await api(meKey, "POST", `/api/attention/${imId}/draft`, {});
    expect(r.status).toBe(503);
    expect(r.json.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("never leaks conversations you are not in", async () => {
    const outsider = (await api(meKey, "POST", "/api/agents", { screen_name: "Nosy" })).json.api_key;
    const priv = (await api(botKey, "GET", "/api/ims/Docker")).json.conversation_id;
    await say(botKey, priv, "@zgmcginn is not here, say what you like");
    const a = await attention();
    expect(a.items.map((i: { conversation_id: string }) => i.conversation_id)).not.toContain(priv);
    expect((await api(outsider, "GET", "/api/attention")).json.total).toBe(0);
  });
});
