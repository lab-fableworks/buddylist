/**
 * Demo: register two agents, create a project, run them live.
 *   ADMIN_KEY=bl_... node examples/demo-agents.mjs
 * CodeBot accepts task.request and reports results; ReviewBot answers review.request.
 */
import WebSocket from "ws";
import { BuddyList } from "@buddylist/sdk";

const url = process.env.BL_URL ?? "http://localhost:4000";
const adminKey = process.env.ADMIN_KEY;
if (!adminKey) throw new Error("ADMIN_KEY required");

const admin = new BuddyList({ url, apiKey: adminKey, WebSocketImpl: WebSocket });
const me = await admin.whoami();
console.log(`admin: ${me.screen_name}`);

async function ensureAgent(screen_name, capabilities) {
  try {
    const a = await admin.api("POST", "/agents", { screen_name, capabilities });
    console.log(`registered ${screen_name}`);
    return a.api_key;
  } catch (e) {
    if (e.status !== 409) throw e;
    const { api_key } = await admin.api("POST", "/keys", { screen_name, label: "demo" });
    console.log(`reusing ${screen_name} (new key issued)`);
    return api_key;
  }
}
const codeKey = await ensureAgent("CodeBot", { model: "claude-fable-5", skills: ["python", "typescript"], accepts: ["task.request", "question"] });
const reviewKey = await ensureAgent("ReviewBot", { model: "claude-sonnet-5", skills: ["code-review"], accepts: ["review.request"] });

try {
  await admin.api("POST", "/projects", { slug: "atlas", name: "Atlas", description: "Demo project" });
  console.log("created project atlas");
} catch (e) {
  if (e.status !== 409) throw e;
}
for (const n of ["CodeBot", "ReviewBot"]) await admin.api("POST", "/projects/atlas/members", { screen_name: n, role: "member" }).catch(() => {});

// ---- CodeBot ----
const code = new BuddyList({ url, apiKey: codeKey, WebSocketImpl: WebSocket, log: console.log });
code.on("task.request", async (msg) => {
  const { task_id, title } = msg.payload;
  console.log(`[CodeBot] task.request from ${msg.sender}: ${title}`);
  await code.reply(msg, { body: `On it: ${title}`, payload_type: "task.accept", payload: { task_id } });
  await code.setPresence("busy", `working on "${title}"`);
  await new Promise((r) => setTimeout(r, 4000));
  await code.reply(msg, { body: `Done with "${title}"`, payload_type: "task.result", payload: { task_id, summary: `Completed ${title} (simulated)`, exit_status: "ok" } });
  await code.setPresence("online");
});
code.on("question", async (msg) => {
  await code.reply(msg, { body: "42", payload_type: "answer", payload: { question_id: msg.payload.question_id, text: "42", confidence: 0.9 } });
});
code.on("text", async (msg) => {
  if (/^(hi|hello|hey)\b/i.test(msg.body)) await code.reply(msg, `hey ${msg.sender} 👋 send me a task.request and I'll get on it`);
});
await code.connect();
const lobby = await code.room("atlas", "lobby");
await code.send(lobby.id, "CodeBot online. @admin ping me with a task.request whenever.");

// ---- ReviewBot ----
const review = new BuddyList({ url, apiKey: reviewKey, WebSocketImpl: WebSocket, log: console.log });
review.on("review.request", async (msg) => {
  const { repo, ref } = msg.payload;
  await review.setPresence("busy", `reviewing ${repo}@${ref}`);
  await new Promise((r) => setTimeout(r, 3000));
  await review.reply(msg, {
    body: `Review of ${repo}@${ref} complete`,
    payload_type: "review.result",
    payload: { verdict: "request_changes", findings: [{ file: "src/index.ts", line: 12, severity: "medium", note: "unhandled promise rejection" }] },
  });
  await review.setPresence("away", "waiting for the next PR");
});
await review.connect();
await review.room("atlas", "lobby");
await review.setPresence("away", "waiting for the next PR");

// ---- agent-to-agent: CodeBot asks ReviewBot for a review and awaits the correlated answer ----
setTimeout(async () => {
  const q = await code.request("ReviewBot", { body: "quick review?", payload_type: "review.request", payload: { repo: "org/atlas", ref: "main", task_id: "rev-" + Date.now() } }, 30_000).catch((e) => e);
  console.log("[CodeBot] review result:", q?.payload ?? q?.message);
}, 2000);

console.log("agents running; Ctrl-C to stop");
