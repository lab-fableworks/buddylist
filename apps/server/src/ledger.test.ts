/**
 * The bits ledger.
 *
 * Speech is the largest flow in this economy, so the tests that matter are about honesty:
 * costed and uncosted messages must be told apart, and the text view must be readable rather
 * than merely produced.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, bootstrapAdmin } from "./app.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let adminKey: string;
let ravenKey: string;
let roomId: string;

/** content-type only when there IS a body: Fastify 400s on an empty JSON body. */
const inj = async (key: string, method: "GET" | "POST", url: string, payload?: unknown) => {
  // The awaited value is a Response, but the Chain overload makes TS think `.body` is a
  // method, so the shape is stated once here instead of at every call site.
  const r = (await app.inject({
    method,
    url,
    payload: payload as never,
    headers: { authorization: `Bearer ${key}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
  })) as unknown as { statusCode: number; body: string; headers: Record<string, string> };
  return r;
};
const say = (key: string, body: string, ext?: Record<string, unknown>) =>
  inj(key, "POST", `/api/rooms/${roomId}/messages`, { body, payload_type: "text", ...(ext ? { payload: { extensions: ext } } : {}) });

beforeAll(async () => {
  const built = await buildApp({ pgliteDir: undefined });
  app = built.app;
  adminKey = (await bootstrapAdmin(built.ctx, "zgmcginn", "z@example.com"))!;
  ravenKey = JSON.parse((await inj(adminKey, "POST", "/api/agents", { screen_name: "Raven" })).body).api_key;
  await inj(adminKey, "POST", "/api/projects", { slug: "society", name: "Society" });
  await inj(adminKey, "POST", "/api/projects/society/members", { screen_name: "Raven" });
  roomId = JSON.parse((await inj(adminKey, "POST", "/api/projects/society/rooms", { name: "market" })).body).id;
  await inj(ravenKey, "POST", `/api/rooms/${roomId}/join`);

  await say(ravenKey, "The quiet was already there.", { v: 1, bits: -2, tokens: 4090, usd: 0.00041, balance: 593 });
  await say(ravenKey, "You just finally noticed.", { v: 1, bits: -1, tokens: 3000, usd: 0.0003, balance: 592 });
  await say(adminKey, "a human speaks for free");
  await inj(ravenKey, "POST", `/api/rooms/${roomId}/messages`, { body: "tip", payload_type: "x-economy.transfer", payload: { to: "zgmcginn", amount: 20, reason: "for the work" } });
  await inj(ravenKey, "POST", `/api/rooms/${roomId}/messages`, { body: "(Whip report filed)", payload_type: "x-role.report", payload: { role: "Whip", paid: 6 } });
});
afterAll(async () => {
  await app.close();
});

describe("ledger", () => {
  it("sums what speech cost, and keeps uncosted messages separate", async () => {
    const j = JSON.parse((await inj(adminKey, "GET", "/api/projects/society/ledger")).body);
    const raven = j.accounts.find((a: { who: string }) => a.who === "Raven");
    expect(raven).toMatchObject({ spoke: 2, spentBits: 3, tokens: 7090, tipsOut: 20, rolePay: 6, lastBalance: 592 });
    // The human pays nothing, so their message is counted as uncosted rather than as free speech.
    const human = j.accounts.find((a: { who: string }) => a.who === "zgmcginn");
    expect(human).toMatchObject({ spoke: 0, uncosted: 1, tipsIn: 20 });
    expect(j.totals).toMatchObject({ spent: 3, tokens: 7090, moved: 20, minted: 6, uncosted: 1 });
  });

  it("serves plain text that a person can actually read", async () => {
    const r = await inj(adminKey, "GET", "/api/projects/society/ledger?format=text");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
    expect(r.body).toContain("BITS LEDGER — Society");
    expect(r.body).toContain("3 bits spent on speech across 2 costed messages.");
    expect(r.body).toContain("1 messages carry no cost");
    // Blank lines are part of being readable; a wall of text is not a document.
    expect(r.body.split("\n").filter((l) => l === "").length).toBeGreaterThan(2);
    expect(r.body).toMatch(/Raven\s+2\s+3/);
  });

  it("refuses someone who is not in the project", async () => {
    const outsider = JSON.parse((await inj(adminKey, "POST", "/api/agents", { screen_name: "Nosy" })).body).api_key;
    expect((await inj(outsider, "GET", "/api/projects/society/ledger")).statusCode).toBe(403);
  });
});
