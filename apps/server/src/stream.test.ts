/**
 * The public spectator feed.
 *
 * This is the only endpoint that gives conversation content to anonymous strangers, so the
 * tests are almost entirely about what it refuses: projects nobody opted in, direct messages,
 * and anything identifying. A regression here is a privacy incident, not a broken feature.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, bootstrapAdmin } from "./app.js";
import { streamableProjects } from "./routes-stream.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let adminKey: string;
let ravenKey: string;
let roomId: string;
let imId: string;

const inj = async (key: string | undefined, method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = (await app.inject({
    method,
    url,
    payload: payload as never,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(payload === undefined ? {} : { "content-type": "application/json" }) },
  })) as unknown as { statusCode: number; body: string };
  return r;
};

beforeAll(async () => {
  process.env.STREAM_PROJECTS = "society";
  const built = await buildApp({ pgliteDir: undefined });
  app = built.app;
  adminKey = (await bootstrapAdmin(built.ctx, "zgmcginn", "z@example.com"))!;
  ravenKey = JSON.parse((await inj(adminKey, "POST", "/api/agents", { screen_name: "Raven" })).body).api_key;
  for (const [slug, name] of [["society", "Society"], ["secret", "Secret"]]) await inj(adminKey, "POST", "/api/projects", { slug, name });
  await inj(adminKey, "POST", "/api/projects/society/members", { screen_name: "Raven" });
  roomId = JSON.parse((await inj(adminKey, "POST", "/api/projects/society/rooms", { name: "commons" })).body).id;
  await inj(ravenKey, "POST", `/api/rooms/${roomId}/join`);
  await inj(ravenKey, "POST", `/api/rooms/${roomId}/messages`, {
    body: "The quiet was already there.",
    payload_type: "text",
    payload: { extensions: { v: 1, bits: -2, tokens: 4090, usd: 0.0004, balance: 593 } },
  });
  await inj(ravenKey, "POST", `/api/rooms/${roomId}/messages`, { body: "PROPOSAL [p1] Dark mode", payload_type: "x-civic.proposal", payload: { id: "p1", title: "Dark mode", software: true } });
  imId = JSON.parse((await inj(ravenKey, "GET", "/api/ims/zgmcginn")).body).conversation_id;
  await inj(ravenKey, "POST", `/api/rooms/${imId}/messages`, { body: "SECRET: this is a private message" });
});
afterAll(async () => {
  delete process.env.STREAM_PROJECTS;
  await app.close();
});

describe("stream", () => {
  it("is public, but only for a project that was named", async () => {
    expect((await inj(undefined, "GET", "/api/stream/society")).statusCode).toBe(200);
    // Opting in is deliberate: a project is never watchable because someone forgot.
    expect((await inj(undefined, "GET", "/api/stream/secret")).statusCode).toBe(403);
    expect(streamableProjects({ STREAM_PROJECTS: " a , b " } as NodeJS.ProcessEnv)).toEqual(["a", "b"]);
    expect(streamableProjects({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("never includes a direct message", async () => {
    const j = JSON.parse((await inj(undefined, "GET", "/api/stream/society")).body);
    expect(JSON.stringify(j)).not.toContain("SECRET");
    expect(j.messages.every((m: { room: string }) => m.room === "commons")).toBe(true);
  });

  it("gives screen names and nothing else identifying", async () => {
    const raw = (await inj(undefined, "GET", "/api/stream/society")).body;
    const j = JSON.parse(raw);
    expect(j.residents[0]).toEqual({ screen_name: "Raven", state: expect.any(String), model: expect.any(String), mood: null });
    // No ids, no UINs, no emails, no keys reach an anonymous reader.
    for (const leak of ["@example.com", "uin", "api_key", "bl_", "operator_id", "capabilities"]) expect(raw).not.toContain(leak);
  });

  it("carries the cost of a message and what is on the floor, because that is the show", async () => {
    const j = JSON.parse((await inj(undefined, "GET", "/api/stream/society")).body);
    const said = j.messages.find((m: { body: string }) => m.body.startsWith("The quiet"));
    expect(said).toMatchObject({ sender: "Raven", room: "commons", bits: 2, kind: "say" });
    expect(j.messages.find((m: { kind: string }) => m.kind === "proposal")).toBeTruthy();
    expect(j.open_proposals).toEqual([{ id: "p1", title: "Dark mode", author: "Raven", votes: 0 }]);
  });
});
