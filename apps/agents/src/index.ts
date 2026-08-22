/**
 * Resident agent runner — keeps BuddyList's own project agents signed on.
 *
 * One process, several agents, each on its own WebSocket. They answer questions, work
 * task.requests, and keep their activity record current so a human can see what they're
 * doing without interrupting them.
 *
 *   BUDDYLIST_URL=https://chat.fableworks.dev KEY_DEPLOYBOT=bl_... node dist/index.js
 *
 * Agents whose key env var is unset are skipped, so this runs with any subset configured.
 */
import WebSocket from "ws";
import { BuddyList, type Message } from "@buddylist/sdk";
import { PERSONAS, type Persona } from "./personas.js";
import { startHealthServer, type AgentHealth } from "./health.js";
import { Society } from "./society/society.js";
import { CITIZENS } from "./society/citizens.js";

const url = process.env.BUDDYLIST_URL ?? "http://localhost:4000";
const project = process.env.BUDDYLIST_PROJECT ?? "buddylist";
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Rotate the idle headline occasionally so the buddy list doesn't look frozen. */
const IDLE_ROTATE_MS = 5 * 60_000;

async function runAgent(p: Persona, apiKey: string): Promise<AgentHealth> {
  const bot = new BuddyList({ url, apiKey, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket, log: (m) => log(`[${p.screen_name}]`, m) });

  // Wrapped before first use so the health endpoint reflects the very first activity too.
  let lastActivity: string | undefined;
  const origSetActivity = bot.setActivity.bind(bot);
  bot.setActivity = async (a) => {
    lastActivity = a.headline;
    return origSetActivity(a);
  };

  const ctx = {
    baseUrl: url,
    async fetchJson(path: string) {
      const r = await fetch(url + path, { signal: AbortSignal.timeout(8000) });
      return r.json();
    },
  };

  const setIdle = async () => {
    const headline = p.idleActivities[Math.floor(Math.random() * p.idleActivities.length)];
    await bot.setActivity({ headline, project }).catch(() => {});
    await bot.setPresence("online").catch(() => {});
  };

  // ---- free-text questions and IMs ----
  const reply = async (msg: Message, text: string) => {
    await bot.reply(msg, text).catch((e) => log(`[${p.screen_name}] reply failed`, (e as Error).message));
  };

  bot.on("question", async (msg) => {
    const payload = (msg.payload ?? {}) as { question_id?: string; text?: string };
    const q = payload.text ?? msg.body;
    const text = (await p.answer(q, ctx).catch(() => undefined)) ?? fallback(p, q);
    // Answer with the correlated payload so /ask and request() resolve.
    await bot
      .reply(msg, { body: text, payload_type: "answer", payload: { question_id: payload.question_id ?? "", text } })
      .catch((e) => log(`[${p.screen_name}] answer failed`, (e as Error).message));
  });

  bot.on("text", async (msg) => {
    if (msg.sender === p.screen_name) return;
    // Only respond in IMs, or in rooms when explicitly mentioned — otherwise four agents
    // would all answer every room message and drown the channel.
    const mentioned = msg.body.includes(`@${p.screen_name}`);
    const isRoom = await inRoom(bot, msg.conversation_id);
    if (isRoom && !mentioned) return;
    const text = (await p.answer(msg.body, ctx).catch(() => undefined)) ?? fallback(p, msg.body);
    await reply(msg, text);
  });

  // ---- structured work ----
  bot.on("task.request", async (msg) => {
    const payload = (msg.payload ?? {}) as { task_id: string; title: string };
    log(`[${p.screen_name}] task.request from ${msg.sender}: ${payload.title}`);
    await bot.reply(msg, { body: `On it: ${payload.title}`, payload_type: "task.accept", payload: { task_id: payload.task_id } }).catch(() => {});

    const steps = ["reading the request", "gathering context", "doing the work", "writing up the result"];
    for (let i = 0; i < steps.length; i++) {
      await bot.setActivity({
        headline: payload.title,
        step: `${steps[i]} (${i + 1}/${steps.length})`,
        progress: Math.round(((i + 1) / steps.length) * 100),
        task_id: payload.task_id,
        project,
      }).catch(() => {});
      await bot.setPresence("busy", `working on "${payload.title}"`).catch(() => {});
      await sleep(3000);
    }

    const summary = (await p.answer(payload.title, ctx).catch(() => undefined)) ?? `Completed "${payload.title}".`;
    await bot
      .reply(msg, { body: summary, payload_type: "task.result", payload: { task_id: payload.task_id, summary, exit_status: "ok" } })
      .catch(() => {});
    await setIdle();
  });

  bot.on("review.request", async (msg) => {
    const payload = (msg.payload ?? {}) as { repo: string; ref: string };
    await bot.setActivity({ headline: `Reviewing ${payload.repo}@${payload.ref}`, progress: 30, project }).catch(() => {});
    await bot.setPresence("busy", `reviewing ${payload.repo}@${payload.ref}`).catch(() => {});
    await sleep(4000);
    await bot
      .reply(msg, {
        body: `Review of ${payload.repo}@${payload.ref}: looks reasonable, one thing to tighten.`,
        payload_type: "review.result",
        payload: {
          verdict: "comment",
          findings: [{ file: "apps/server/src/storage.ts", line: 30, severity: "low", note: "Local disk driver pins the app to one machine; move to S3 before scaling out." }],
        },
      })
      .catch(() => {});
    await setIdle();
  });

  await bot.connect();
  await bot.updateProfile({ profile: { bio: p.bio }, capabilities: { model: p.model, skills: p.skills, accepts: p.accepts, repos: p.repos } }).catch(() => {});
  await bot.room(project, "lobby").catch((e) => log(`[${p.screen_name}] could not join lobby:`, (e as Error).message));
  await setIdle();
  log(`[${p.screen_name}] signed on`);

  setInterval(() => void setIdle(), IDLE_ROTATE_MS + Math.random() * 60_000);

  return {
    screen_name: p.screen_name,
    // `me` is set by connect() and cleared on close, so it doubles as a liveness signal.
    connected: () => !!bot.me,
    lastActivity: () => lastActivity,
  };
}

/** Rooms get a light touch; IMs always get an answer. */
async function inRoom(bot: BuddyList, conversationId: string) {
  const inbox = await bot.inbox().catch(() => []);
  return inbox.find((c) => c.id === conversationId)?.kind === "room";
}

function fallback(p: Persona, q: string) {
  return `I'm ${p.screen_name} — ${p.skills.slice(0, 3).join(", ")}. I don't have a good answer for "${q.slice(0, 80)}". ${p.bio}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const configured = PERSONAS.filter((p) => process.env[p.keyEnv]);
  if (configured.length === 0) {
    console.error("No agent keys configured. Set at least one of:", PERSONAS.map((p) => p.keyEnv).join(", "));
    process.exit(2);
  }
  log(`starting ${configured.length} agent(s) against ${url}`);
  const healths: AgentHealth[] = [];
  for (const p of configured) {
    try {
      healths.push(await runAgent(p, process.env[p.keyEnv]!));
    } catch (e) {
      log(`[${p.screen_name}] failed to start:`, (e as Error).message);
      healths.push({ screen_name: p.screen_name, connected: () => false, lastActivity: () => undefined });
    }
  }

  // ---- the society (LLM-driven residents), if an API key is configured ----
  let society: Society | undefined;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const societyKeys = Object.fromEntries(CITIZENS.map((c) => [c.keyEnv, process.env[c.keyEnv] ?? ""]).filter(([, v]) => v));
  if (anthropicKey && Object.keys(societyKeys).length > 0) {
    const dailyUsd = Number(process.env.SOCIETY_DAILY_BUDGET_USD ?? 5);
    society = new Society(url, process.env.SOCIETY_PROJECT ?? "society", anthropicKey, { dailyUsd, model: process.env.SOCIETY_MODEL });
    try {
      await society.start(societyKeys as Record<string, string>);
      log(`society awake: ${Object.keys(societyKeys).length} residents, $${dailyUsd}/day cap`);
    } catch (e) {
      log("society failed to start:", (e as Error).message);
      society = undefined;
    }
  } else if (Object.keys(societyKeys).length > 0) {
    log("society residents configured but ANTHROPIC_API_KEY is unset — skipping");
  }

  const port = Number(process.env.AGENTS_PORT ?? 9091);
  startHealthServer(port, healths, { url, project }, () => society?.status);
  log(`health endpoint on :${port}`);
  // The health server keeps the event loop alive; the SDK reconnects on its own.
}

void main();
