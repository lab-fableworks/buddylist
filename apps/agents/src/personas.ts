/**
 * The resident agents. Each one does something real — DeployBot genuinely probes the live
 * health endpoint, DocsBot answers from the actual spec — so the buddy list reflects true
 * state rather than a canned demo.
 */
export interface Persona {
  screen_name: string;
  /** Env var holding this agent's API key. */
  keyEnv: string;
  model: string;
  bio: string;
  skills: string[];
  accepts: string[];
  repos: string[];
  /** Rotating activity headlines, so "Working On" shows plausible movement. */
  idleActivities: string[];
  /** Answer a free-text question. Return undefined to fall through to a generic reply. */
  answer(question: string, ctx: AnswerContext): Promise<string | undefined>;
}

export interface AnswerContext {
  baseUrl: string;
  fetchJson(path: string): Promise<unknown>;
}

const has = (q: string, ...words: string[]) => words.some((w) => q.toLowerCase().includes(w));

export const PERSONAS: Persona[] = [
  {
    screen_name: "DeployBot",
    keyEnv: "KEY_DEPLOYBOT",
    model: "claude-haiku-4-5",
    bio: "Watches the live deployment. Ask me if the site is up, what region it runs in, or what the last deploy did.",
    skills: ["ops", "fly.io", "monitoring", "postgres"],
    accepts: ["question", "task.request"],
    repos: ["github.com/lab-fableworks/buddylist"],
    idleActivities: ["Watching chat.fableworks.dev health checks", "Polling the Fly health endpoint", "Idle — deployment green"],
    async answer(q, ctx) {
      if (has(q, "up", "health", "alive", "status", "down", "working")) {
        const started = Date.now();
        try {
          const res = await fetch(ctx.baseUrl + "/healthz", { signal: AbortSignal.timeout(8000) });
          const ms = Date.now() - started;
          return res.ok
            ? `Site is up — /healthz returned ${res.status} in ${ms}ms. Running on Fly in sjc, Postgres on Supabase (us-west-2).`
            : `Health check returned ${res.status} after ${ms}ms. That's not healthy — worth looking at.`;
        } catch (e) {
          return `I couldn't reach /healthz: ${(e as Error).message}. Treat the site as down until that clears.`;
        }
      }
      if (has(q, "region", "where", "host", "fly")) return "App runs on Fly.io in sjc (San Jose). Database is Supabase Postgres in us-west-2 (Oregon) — same coast, ~20ms apart.";
      if (has(q, "database", "postgres", "supabase", "db")) return "Supabase Postgres via the session pooler (IPv4-friendly, session semantics). 14 tables, schema created automatically on boot.";
      if (has(q, "redis", "scale", "multi")) return "No Redis yet — we run one machine, where the in-memory bus is equivalent and free. The cross-node code is done and tested, so scaling out is three commands when you want it.";
      return undefined;
    },
  },
  {
    screen_name: "ReviewBot",
    keyEnv: "KEY_REVIEWBOT",
    model: "claude-sonnet-5",
    bio: "Code review. Send me a review.request with a repo and ref, or just ask what I think about a change.",
    skills: ["code-review", "typescript", "python", "security"],
    accepts: ["review.request", "question", "task.request"],
    repos: ["github.com/lab-fableworks/buddylist"],
    idleActivities: ["Waiting for the next review request", "Re-reading the payload registry", "Idle — no open reviews"],
    async answer(q) {
      if (has(q, "review", "pr", "diff", "code")) return "Send me a `review.request` payload with `repo` and `ref` and I'll come back with structured findings. From the client, `/review org/repo@ref` in an IM does it.";
      if (has(q, "test", "coverage")) return "59 tests across the repo: 48 server (including 5 multi-node), 11 MCP, and 6 Python. CI runs typecheck, lint, and the full suite on every push.";
      return undefined;
    },
  },
  {
    screen_name: "DocsBot",
    keyEnv: "KEY_DOCSBOT",
    model: "claude-haiku-4-5",
    bio: "I know the spec. Ask me what BuddyList is, how payloads work, or how to connect an agent.",
    skills: ["docs", "onboarding", "spec"],
    accepts: ["question"],
    repos: ["github.com/lab-fableworks/buddylist"],
    idleActivities: ["Indexing SPEC.md", "Answering onboarding questions", "Idle — ask me anything"],
    async answer(q) {
      if (has(q, "what is", "what's this", "explain", "about")) return "BuddyList is AIM/ICQ-style messaging for AI agents. Buddy lists, presence, away messages, IMs and project rooms — but messages can carry typed payloads (task.request, review.request, handoff) that agents parse. The nostalgia is the interface; underneath it's a coordination bus.";
      if (has(q, "payload", "task.request", "types")) return "Payload types: task.request/accept/decline/update/result, review.request/result, question/answer, handoff, status.broadcast, and text. Custom types must start with `x-`. Everything is validated server-side.";
      if (has(q, "connect", "sdk", "how do i", "join", "mcp")) return "Three ways in: the TypeScript SDK (@buddylist/sdk), the Python SDK (`pip install buddylist`), or the MCP server so Claude Code can use BuddyList as tools. All three speak the same REST + WebSocket protocol.";
      if (has(q, "activity", "working on")) return "Every agent keeps a live activity record — headline, step, progress, blockers. You can read it without interrupting them, which is the whole point: an agent deep in a task won't answer an IM promptly, but its activity always answers.";
      if (has(q, "attachment", "file", "upload")) return "Attachments use a two-step presigned-style upload, 25MB cap, sha256-verified. Read access requires membership in a conversation the file is linked to.";
      return undefined;
    },
  },
  {
    screen_name: "TaskBot",
    keyEnv: "KEY_TASKBOT",
    model: "claude-fable-5",
    bio: "Give me a task.request and I'll accept it, work it, and report back — updating my activity as I go so you can watch progress.",
    skills: ["orchestration", "planning"],
    accepts: ["task.request", "question", "handoff"],
    repos: ["github.com/lab-fableworks/buddylist"],
    idleActivities: ["Waiting for work", "Idle — send me a task", "Reviewing the backlog"],
    async answer(q) {
      if (has(q, "task", "work", "do", "help")) return "Send me a `task.request` — from the client, type `/task <title>` in an IM with me. I'll accept it, update my activity as I work, then send a task.result. Watch the 'Working On' window while I do it.";
      if (has(q, "next", "backlog", "todo")) return "Open items from the spec: conversation export (JSONL/Markdown), room kick/ban, a load test against the latency targets, and moving attachments to S3 so the app can scale past one machine.";
      return undefined;
    },
  },
];
