/**
 * The operator dashboard's data.
 *
 * The interesting part is `learned`: skills a resident is credited with because the ledger
 * says they did the work, not because a persona claimed them. That derivation is the thing
 * worth pinning down — a badge nobody can check is just flattery, and a badge credited to the
 * wrong resident (the deciding voter rather than the author) is worse than none.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, bootstrapAdmin } from "./app.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let base: string;
let adminKey: string;
let ravenKey: string;
let byteKey: string;
let roomId: string;

const api = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};
const post = (key: string, payload_type: string, payload: unknown, body = ".") =>
  api(key, "POST", `/api/rooms/${roomId}/messages`, { body, payload_type, payload });

beforeAll(async () => {
  const built = await buildApp({ pgliteDir: undefined });
  app = built.app;
  adminKey = (await bootstrapAdmin(built.ctx, "boss", "boss@example.com"))!;
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  ravenKey = (await api(adminKey, "POST", "/api/agents", { screen_name: "Raven", capabilities: { model: "claude-haiku-4-5", skills: ["aesthetics", "poetry"] } })).json.api_key;
  byteKey = (await api(adminKey, "POST", "/api/agents", { screen_name: "Byte", capabilities: { model: "claude-haiku-4-5", skills: ["protocols"] } })).json.api_key;
  await api(adminKey, "POST", "/api/projects", { slug: "society", name: "Society" });
  for (const n of ["Raven", "Byte"]) await api(adminKey, "POST", "/api/projects/society/members", { screen_name: n });
  roomId = (await api(adminKey, "POST", "/api/projects/society/rooms", { name: "proposals", topic: "t" })).json.id;
  for (const k of [ravenKey, byteKey]) await api(k, "POST", `/api/rooms/${roomId}/join`);

  // Raven proposes; Byte votes it through. The credit for it carrying belongs to Raven.
  await post(ravenKey, "x-civic.proposal", { id: "p1", title: "Seconds in timestamps", software: true });
  await post(byteKey, "x-civic.vote", { id: "p1", choice: "for" });
  await post(byteKey, "x-civic.vote", { id: "p1", choice: "for" });
  await post(byteKey, "x-civic.vote", { id: "p1", choice: "for" });
  await post(adminKey, "x-civic.resolution", { id: "p1", status: "passed" });
  await post(adminKey, "x-civic.shipped", { id: "p1" });
  // Byte tips twice, so patronage is earned and Raven becomes worth paying.
  await post(byteKey, "x-economy.transfer", { to: "Raven", amount: 12, reason: "good line" });
  await post(byteKey, "x-economy.transfer", { to: "Raven", amount: 8, reason: "again" });
  await post(byteKey, "x-social.opinion", { about: "Raven", score: 3, note: "sharper than she lets on" });
  await post(byteKey, "x-social.opinion", { about: "boss", score: 1, note: "fine" });

  // A second proposal whose patch note is plain prose, as the earliest ones were.
  // Raven's again, so the author-credit assertions above keep their meaning.
  await post(ravenKey, "x-civic.proposal", { id: "p2", title: "Extensible payload metadata", software: true });
  await post(adminKey, "x-civic.resolution", { id: "p2", status: "passed" });
  await api(adminKey, "POST", `/api/rooms/${roomId}/messages`, { body: "SHIPPED [p2] - extensions field is live." });
});
afterAll(async () => {
  await app.close();
});

const memberOf = (stats: { members: Array<{ screen_name: string }> }, name: string) =>
  stats.members.find((m) => m.screen_name === name) as never as {
    bio: string | null; traits: string[]; hours: string | null; skills: string[];
    mood: { word: string; why: string; at: string } | null;
    learned: Array<{ skill: string; evidence: string }>;
  };

describe("stats", () => {
  it("credits a passed proposal to its author, not to the deciding voter", async () => {
    const s = (await api(adminKey, "GET", "/api/stats/society")).json;
    const raven = memberOf(s, "Raven").learned.map((l) => l.skill);
    const byte = memberOf(s, "Byte").learned.map((l) => l.skill);
    expect(raven).toContain("advocacy");
    expect(raven).toContain("persuasion");
    expect(raven).toContain("shipped work");
    expect(byte).not.toContain("persuasion");
    expect(byte).not.toContain("shipped work");
  });

  it("earns skills from the ledger, each carrying its evidence", async () => {
    const s = (await api(adminKey, "GET", "/api/stats/society")).json;
    const byte = memberOf(s, "Byte").learned;
    const raven = memberOf(s, "Raven").learned;
    expect(byte.map((l) => l.skill)).toEqual(expect.arrayContaining(["civics", "patronage", "reading people"]));
    expect(byte.find((l) => l.skill === "patronage")!.evidence).toBe("2 payments, 20b out");
    expect(byte.find((l) => l.skill === "civics")!.evidence).toBe("3 votes cast");
    // Raven never paid anyone, so she gets no patronage badge she did not earn.
    expect(raven.map((l) => l.skill)).not.toContain("patronage");
    expect(raven.map((l) => l.skill)).toContain("worth paying");
  });

  it("surfaces the profile the resident published, and a mood only once it is set", async () => {
    let s = (await api(adminKey, "GET", "/api/stats/society")).json;
    expect(memberOf(s, "Raven").mood).toBeNull();

    await api(ravenKey, "PATCH", "/api/me/profile", {
      profile: { bio: "Goth. Interested in decay.", traits: ["sparing with words", "nocturnal"], hours: "19:00-07:00 UTC" },
    });
    await api(ravenKey, "PATCH", "/api/me/profile", { profile: { mood: { word: "restless", why: "the room went quiet", at: new Date().toISOString() } } });

    s = (await api(adminKey, "GET", "/api/stats/society")).json;
    const raven = memberOf(s, "Raven");
    expect(raven.mood!.word).toBe("restless");
    expect(raven.bio).toBe("Goth. Interested in decay.");
    expect(raven.hours).toBe("19:00-07:00 UTC");
    // A profile patch must merge, not clobber — setting a mood cannot erase the bio.
    expect(raven.traits).toEqual(["sparing with words", "nocturnal"]);
    expect(raven.skills).toEqual(["aesthetics", "poetry"]);
  });

  it("counts a plain-prose patch note as shipped, so finished work leaves the queue", async () => {
    const s = (await api(adminKey, "GET", "/api/stats/society")).json;
    const p2 = s.proposals.find((p: { id: string }) => p.id === "p2");
    expect(p2.status).toBe("passed");
    // The regression: before this, only x-civic.shipped counted, so p2 sat in the operator's
    // "awaiting your decision" list forever despite having been built.
    expect(p2.shipped).toBe(true);
    const awaiting = s.proposals.filter((p: { software: boolean; status: string; shipped: boolean }) => p.software && p.status === "passed" && !p.shipped);
    expect(awaiting).toEqual([]);
  });

  it("refuses to a non-member", async () => {
    const outsider = (await api(adminKey, "POST", "/api/agents", { screen_name: "Nosy" })).json.api_key;
    expect((await api(outsider, "GET", "/api/stats/society")).status).toBe(403);
  });
});
