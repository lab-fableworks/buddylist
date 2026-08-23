/**
 * Static serving: the rules that keep a browser from a blank page.
 *
 * The failure this pins: a missing /assets file used to fall through to the SPA handler and
 * come back as HTML with a 200. A module loader receiving text/html refuses it and the page
 * dies silently - seen in production when two machines briefly ran different builds during a
 * rolling deploy. A missing asset must be a real 404; hashed assets must be immutable so a
 * browser that has one never re-fetches it mid-deploy; HTML must always revalidate.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "bl-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>client</title>");
  writeFileSync(join(dir, "dashboard.html"), "<!doctype html><title>dashboard</title>");
  writeFileSync(join(dir, "stream.html"), "<!doctype html><title>live</title>");
  writeFileSync(join(dir, "assets", "stream-abc123.js"), "export {};");
  const built = await buildApp({ pgliteDir: undefined, webDir: dir });
  app = built.app;
});
afterAll(async () => {
  await app.close();
});

const get = async (url: string) => {
  const r = (await app.inject({ method: "GET", url })) as unknown as { statusCode: number; headers: Record<string, string>; body: string };
  return r;
};

describe("static", () => {
  it("404s a missing asset instead of serving the SPA page", async () => {
    const r = await get("/assets/stream-OLDHASH.js");
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-type"]).toMatch(/json/);
    expect(r.body).not.toContain("<!doctype");
  });

  it("marks hashed assets immutable and HTML always-revalidate", async () => {
    expect((await get("/assets/stream-abc123.js")).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    for (const page of ["/", "/stream", "/dashboard"]) expect((await get(page)).headers["cache-control"]).toBe("no-cache");
    // The SPA fallback for an unknown route is HTML too, and must also revalidate.
    expect((await get("/some/client/route")).headers["cache-control"]).toBe("no-cache");
  });

  it("still serves the three pages and keeps API 404s as JSON", async () => {
    expect((await get("/stream")).body).toContain("live");
    expect((await get("/dashboard")).body).toContain("dashboard");
    expect((await get("/")).body).toContain("client");
    // Unauthenticated /api is refused by the auth hook before routing - the point here is
    // only that an API path never comes back as HTML.
    const api = await get("/api/no/such/route");
    expect(api.statusCode).toBe(401);
    expect(api.headers["content-type"]).toMatch(/json/);
  });
});
