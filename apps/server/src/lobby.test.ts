/**
 * The pre-auth lobby. The tests that matter are the boundaries: it must work with no key at
 * all, and it must never list a human or an invisible resident, because anyone can read it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, bootstrapAdmin } from "./app.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let base: string;
let adminKey: string;
const keys: Record<string, string> = {};

const api = async (key: string | undefined, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};

beforeAll(async () => {
  const built = await buildApp({ pgliteDir: undefined });
  app = built.app;
  adminKey = (await bootstrapAdmin(built.ctx, "zgmcginn", "z@example.com"))!;
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  for (const n of ["Byte", "Raven", "Ghost", "Dark"]) keys[n] = (await api(adminKey, "POST", "/api/agents", { screen_name: n })).json.api_key;
  await api(adminKey, "POST", "/api/projects", { slug: "society", name: "Society" });
  for (const n of Object.keys(keys)) await api(adminKey, "POST", "/api/projects/society/members", { screen_name: n });
  const commons = (await api(adminKey, "POST", "/api/projects/society/rooms", { name: "commons", topic: "t" })).json.id;
  await api(keys.Byte, "POST", `/api/rooms/${commons}/join`);

  await api(keys.Byte, "PUT", "/api/me/presence", { state: "online" });
  await api(keys.Raven, "PUT", "/api/me/presence", { state: "away", message: "out walking" });
  await api(keys.Ghost, "PUT", "/api/me/presence", { state: "invisible" });
  // Dark never signs on. The human is online and must still not appear.
  await api(adminKey, "PUT", "/api/me/presence", { state: "online" });
  await api(keys.Byte, "POST", `/api/rooms/${commons}/messages`, { body: "the kerning survives scaling" });
  // The IM must not leak as a room.
  const im = (await api(keys.Raven, "GET", "/api/ims/zgmcginn")).json.conversation_id;
  await api(keys.Raven, "POST", `/api/rooms/${im}/messages`, { body: "catch you later" });
});
afterAll(async () => {
  await app.close();
});

describe("lobby", () => {
  it("answers without a key, and only /api/lobby does", async () => {
    expect((await api(undefined, "GET", "/api/lobby")).status).toBe(200);
    expect((await api(undefined, "GET", "/api/me")).status).toBe(401);
    expect((await api(undefined, "GET", "/api/lobbyx")).status).toBe(401);
  });

  it("lists present residents with their room, never humans or the invisible", async () => {
    const { json } = await api(undefined, "GET", "/api/lobby");
    const names = json.residents.map((r: { screen_name: string }) => r.screen_name);
    expect(names).toEqual(["Byte", "Raven"]);
    expect(json.count).toBe(2);
    const byte = json.residents.find((r: { screen_name: string }) => r.screen_name === "Byte");
    expect(byte).toEqual({ screen_name: "Byte", state: "online", room: "commons" });
    const raven = json.residents.find((r: { screen_name: string }) => r.screen_name === "Raven");
    // Away message shows; the IM she just used does not count as a room.
    expect(raven).toEqual({ screen_name: "Raven", state: "away", message: "out walking" });
    // Nothing identifying leaks: no ids, no uins, no capabilities.
    for (const r of json.residents) expect(Object.keys(r).sort()).toEqual(expect.not.arrayContaining(["id", "uin", "capabilities", "email"]));
  });
});
