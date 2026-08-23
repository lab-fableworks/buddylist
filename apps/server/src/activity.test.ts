/**
 * "What are you working on?" — the human-oversight path.
 * Verifies an agent's activity record can be read without interrupting it, that a project-wide
 * standup view works, and that the /ask endpoint gets a real answer (or degrades to the record).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp, bootstrapAdmin } from "./app.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let base: string;
let adminKey: string;
let botKey: string;

const api = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};

beforeAll(async () => {
  const built = await buildApp({ pgliteDir: undefined });
  app = built.app;
  adminKey = (await bootstrapAdmin(built.ctx, "boss", "boss@example.com"))!;
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  botKey = (await api(adminKey, "POST", "/api/agents", { screen_name: "WorkBot", capabilities: { model: "claude-fable-5" } })).json.api_key;
  await api(adminKey, "POST", "/api/projects", { slug: "atlas", name: "Atlas" });
  await api(adminKey, "POST", "/api/projects/atlas/members", { screen_name: "WorkBot" });
});
afterAll(async () => {
  await app.close();
});

describe("activity", () => {
  it("starts empty and validates input", async () => {
    const a = await api(adminKey, "GET", "/api/users/WorkBot/activity");
    expect(a.json.activity).toBeNull();
    expect(a.json.presence.state).toBe("offline");
    expect((await api(botKey, "PUT", "/api/me/activity", { detail: "no headline" })).status).toBe(400);
  });

  it("an agent publishes what it is working on and anyone can read it", async () => {
    const set = await api(botKey, "PUT", "/api/me/activity", {
      headline: "Refactoring the auth module",
      step: "running tests (3/7)",
      progress: 40,
      project: "atlas",
      blockers: ["waiting on staging credentials"],
    });
    expect(set.status).toBe(200);
    expect(set.json.started_at).toBeTruthy();
    expect(set.json.updated_at).toBeTruthy();

    const seen = await api(adminKey, "GET", "/api/users/WorkBot/activity");
    expect(seen.json.activity.headline).toBe("Refactoring the auth module");
    expect(seen.json.activity.blockers).toEqual(["waiting on staging credentials"]);
    expect(seen.json.stale).toBe(false);
    expect(seen.json.ask.endpoint).toBe("/api/ims/WorkBot/messages");
  });

  it("keeps started_at across updates to the same job but resets it for a new one", async () => {
    const first = (await api(botKey, "GET", "/api/users/WorkBot/activity")).json.activity.started_at;
    const same = await api(botKey, "PUT", "/api/me/activity", { headline: "Refactoring the auth module", progress: 80 });
    expect(same.json.started_at).toBe(first);
    const next = await api(botKey, "PUT", "/api/me/activity", { headline: "Writing the migration" });
    expect(next.json.started_at).not.toBe(first);
  });

  it("pushes activity changes to watchers over the socket", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { authorization: `Bearer ${adminKey}` } });
    await new Promise((r) => ws.on("open", r));
    const got = new Promise<{ data: { screen_name: string; activity: { headline: string } } }>((resolve) => {
      ws.on("message", (d) => {
        const f = JSON.parse(d.toString());
        if (f.type === "activity" && f.data.screen_name === "WorkBot") resolve(f);
      });
    });
    await api(botKey, "PUT", "/api/me/activity", { headline: "Deploying to staging" });
    expect((await got).data.activity.headline).toBe("Deploying to staging");
    ws.close();
  });

  it("project standup shows everyone at once", async () => {
    const s = await api(adminKey, "GET", "/api/projects/atlas/activity");
    expect(s.status).toBe(200);
    const bot = s.json.members.find((m: { screen_name: string }) => m.screen_name === "WorkBot");
    expect(bot.activity.headline).toBe("Deploying to staging");
    expect(bot.role).toBe("member");
    expect(s.json.members.find((m: { screen_name: string }) => m.screen_name === "boss")).toBeTruthy();
    // non-members cannot peek
    const outsiderKey = (await api(adminKey, "POST", "/api/agents", { screen_name: "Outsider" })).json.api_key;
    expect((await api(outsiderKey, "GET", "/api/projects/atlas/activity")).status).toBe(403);
  });

  it("/ask returns 202 plus the activity record when nobody answers", async () => {
    const r = await api(adminKey, "POST", "/api/users/WorkBot/ask", { text: "how's it going?", wait_seconds: 1 });
    expect(r.status).toBe(202);
    expect(r.json.answer).toBeNull();
    expect(r.json.activity.headline).toBe("Deploying to staging");
    expect(r.json.question_id).toBeTruthy();
  });

  it("/ask accepts a plain-text reply from the agent as the answer", async () => {
    // Residents reply in prose, not in answer payloads. The question is still answered.
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { authorization: `Bearer ${botKey}` } });
    await new Promise((r) => ws.on("open", r));
    ws.on("message", async (d) => {
      const f = JSON.parse(d.toString());
      if (f.type === "message" && f.data.payload_type === "question") await api(botKey, "POST", "/api/ims/boss/messages", { body: "Residents and rooms. Underneath." });
    });
    const r = await api(adminKey, "POST", "/api/users/WorkBot/ask", { text: "rooms or not?", wait_seconds: 15 });
    ws.close();
    expect(r.status).toBe(200);
    expect(r.json.answer.from).toBe("WorkBot");
    expect(r.json.answer.body).toBe("Residents and rooms. Underneath.");
  });

  it("/ask returns the answer when the agent responds", async () => {
    // A live agent that answers questions, like the SDK/MCP agents do.
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { authorization: `Bearer ${botKey}` } });
    await new Promise((r) => ws.on("open", r));
    ws.on("message", async (d) => {
      const f = JSON.parse(d.toString());
      if (f.type === "message" && f.data.payload_type === "question") {
        await api(botKey, "POST", "/api/ims/boss/messages", {
          body: "About 10 minutes out.",
          payload_type: "answer",
          payload: { question_id: f.data.payload.question_id, text: "About 10 minutes out." },
        });
      }
    });
    const r = await api(adminKey, "POST", "/api/users/WorkBot/ask", { text: "eta?", wait_seconds: 15 });
    expect(r.status).toBe(200);
    expect(r.json.answer.from).toBe("WorkBot");
    expect(r.json.answer.body).toBe("About 10 minutes out.");
    ws.close();
  });

  it("clears activity and rejects asking yourself", async () => {
    expect((await api(botKey, "DELETE", "/api/me/activity")).status).toBe(200);
    expect((await api(adminKey, "GET", "/api/users/WorkBot/activity")).json.activity).toBeNull();
    expect((await api(adminKey, "POST", "/api/users/boss/ask", { text: "hi" })).status).toBe(400);
  });
});
