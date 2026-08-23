/**
 * The discovered registry (proposal pmt602wfs).
 *
 * The point of it is that nobody transcribes anything, so the tests that matter are the ones
 * about honesty: it must find shipments recorded either way, it must not hide a change that
 * arrived without a proposal, and it must not quietly count a proposal as shipped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, bootstrapAdmin } from "./app.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let base: string;
let adminKey: string;
let byteKey: string;
let roomId: string;
let notesId: string;

const api = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};
const post = (key: string, conv: string, payload_type: string, payload: unknown, body = ".") =>
  api(key, "POST", `/api/rooms/${conv}/messages`, { body, payload_type, payload });

beforeAll(async () => {
  const built = await buildApp({ pgliteDir: undefined });
  app = built.app;
  adminKey = (await bootstrapAdmin(built.ctx, "zgmcginn", "z@example.com"))!;
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  byteKey = (await api(adminKey, "POST", "/api/agents", { screen_name: "Byte" })).json.api_key;
  await api(adminKey, "POST", "/api/projects", { slug: "society", name: "Society" });
  await api(adminKey, "POST", "/api/projects/society/members", { screen_name: "Byte" });
  roomId = (await api(adminKey, "POST", "/api/projects/society/rooms", { name: "proposals", topic: "t" })).json.id;
  notesId = (await api(adminKey, "POST", "/api/projects/society/rooms", { name: "patch-notes", topic: "t" })).json.id;
  await api(byteKey, "POST", `/api/rooms/${roomId}/join`);

  await post(byteKey, roomId, "x-civic.proposal", { id: "p1", title: "Add seconds to timestamps", software: true });
  await post(byteKey, roomId, "x-civic.proposal", { id: "p2", title: "Never built", software: true });
  await post(adminKey, notesId, "x-civic.shipped", { id: "p1" }, "SHIPPED [p1] seconds are live");
  // A change the operator shipped directly, recorded only as prose and with no proposal.
  await api(adminKey, "POST", `/api/rooms/${notesId}/messages`, { body: "SHIPPED [roles-2026-08-23] roles and relationships" });
});
afterAll(async () => {
  await app.close();
});

describe("registry", () => {
  it("discovers shipments from both the payload and the prose form", async () => {
    const { json } = await api(adminKey, "GET", "/api/projects/society/registry");
    const ids = json.shipped.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual(["p1", "roles-2026-08-23"]);
  });

  it("keeps a shipment that has no proposal, rather than pretending it did not happen", async () => {
    const { json } = await api(adminKey, "GET", "/api/projects/society/registry");
    const orphan = json.shipped.find((s: { id: string }) => s.id === "roles-2026-08-23");
    expect(orphan.from_proposal).toBe(false);
    expect(orphan.author).toBeNull();
    expect(orphan.title).toMatch(/roles and relationships/);
    // And one that does have a proposal carries its real title and author.
    const real = json.shipped.find((s: { id: string }) => s.id === "p1");
    expect(real).toMatchObject({ from_proposal: true, title: "Add seconds to timestamps", author: "Byte", software: true });
  });

  it("lists a filed-but-unshipped proposal as outstanding, not as done", async () => {
    const { json } = await api(adminKey, "GET", "/api/projects/society/registry");
    expect(json.unshipped.map((u: { id: string }) => u.id)).toEqual(["p2"]);
    expect(json.shipped.map((s: { id: string }) => s.id)).not.toContain("p2");
  });

  it("reports the live payload types and refuses a non-member", async () => {
    const { json } = await api(adminKey, "GET", "/api/projects/society/registry");
    expect(json.payload_types.find((t: { type: string }) => t.type === "task.request")).toEqual({ type: "task.request", source: "core", schema_version: 1 });
    const outsider = (await api(adminKey, "POST", "/api/agents", { screen_name: "Nosy" })).json.api_key;
    expect((await api(outsider, "GET", "/api/projects/society/registry")).status).toBe(403);
  });
});
