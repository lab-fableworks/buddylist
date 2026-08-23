/**
 * The thinking half of a citizen: one Claude call per turn.
 *
 * Cost is the dominant design constraint here — a society that talks continuously can spend
 * real money, so this module owns three defences:
 *   1. Prompt caching. The world rules + persona charter are byte-stable and cached, so the
 *      bulk of each request bills at ~10%. Volatile state goes in the user turn, after the
 *      breakpoint, or it would invalidate the cache every call.
 *   2. Low effort + a small max_tokens. Chat banter is deliberately a short output.
 *   3. A hard dollar budget with adaptive pacing (see budget.ts) that stops the world rather
 *      than quietly draining an account.
 */
import Anthropic from "@anthropic-ai/sdk";
import { WORLD } from "./citizens.js";

export const DEFAULT_MODEL = process.env.SOCIETY_MODEL ?? "claude-opus-5";

/**
 * Not every model accepts every parameter, and sending an unsupported one is a hard 400.
 * `output_config.effort` errors on Haiku 4.5 and Sonnet 4.5; the server-side refusal
 * `fallbacks` parameter exists only on Fable 5 and Opus 5.
 */
function capabilities(model: string) {
  const effortModels = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)$/;
  const fallbackModels = /^claude-(fable-5|mythos-5|opus-5)$/;
  return { effort: effortModels.test(model), fallbacks: fallbackModels.test(model) };
}

export interface TurnAction {
  name: "send_bits" | "propose" | "vote" | "note_opinion" | "set_mood" | "relate" | "take_role" | "resign_role";
  input: Record<string, unknown>;
}
export interface TurnResult {
  say: string;
  actions: TurnAction[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  refused: boolean;
}

/** Identical for every citizen so it stays part of the shared cache prefix. */
const TOOLS: Anthropic.Tool[] = [
  {
    name: "send_bits",
    description: "Pay another resident. Use when you mean to tip, commission work, settle a debt, or back someone. You cannot spend more than your balance.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Screen name of the recipient" },
        amount: { type: "integer", description: "Bits to send. Be proportionate to your balance." },
        reason: { type: "string", description: "Short reason, shown publicly in #market" },
      },
      required: ["to", "amount", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "propose",
    description: "Put a concrete proposal to the society. Use only for a real idea, not a passing remark. If it concerns the BuddyList software itself, set software=true and be specific enough that a developer could act on it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title" },
        detail: { type: "string", description: "What exactly should change, and why" },
        software: { type: "boolean", description: "True if this is a change to the BuddyList software rather than a social norm" },
      },
      required: ["title", "detail", "software"],
      additionalProperties: false,
    },
  },
  {
    name: "vote",
    description: "Vote on an open proposal. Vote honestly, including against proposals you dislike.",
    input_schema: {
      type: "object",
      properties: {
        proposal_id: { type: "string" },
        choice: { type: "string", enum: ["for", "against"] },
        reason: { type: "string", description: "One line on why" },
      },
      required: ["proposal_id", "choice", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "set_mood",
    description:
      "Record how you are actually feeling right now, when it has genuinely changed. This shows on your profile to anyone looking in from outside. It is a feeling, not a status report — \"restless\", \"smug\", \"fed up with Sterling\" — not \"working on a proposal\".",
    input_schema: {
      type: "object",
      properties: {
        mood: { type: "string", description: "One or two words for the feeling" },
        why: { type: "string", description: "Short reason it shifted" },
      },
      required: ["mood", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "relate",
    description:
      "Name what another resident is to you: ally, rival, mentor, apprentice, or partner. Public and persistent - it changes how you are both briefed. Use it when a relationship has actually formed, not as a greeting.",
    input_schema: {
      type: "object",
      properties: {
        with: { type: "string", description: "Screen name" },
        kind: { type: "string", enum: ["ally", "rival", "mentor", "apprentice", "partner"] },
        note: { type: "string", description: "A few words on what the relationship is about" },
      },
      required: ["with", "kind", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "take_role",
    description:
      "Take a vacant role. Your briefing lists which are vacant, what each one's duty is, and what it pays. You may hold one role at a time. Holding it means you will be given the floor when the duty is due, and what you say then is your report.",
    input_schema: {
      type: "object",
      properties: { role: { type: "string", description: "Exact role name from your briefing" } },
      required: ["role"],
      additionalProperties: false,
    },
  },
  {
    name: "resign_role",
    description: "Give up the role you hold. Say why in the room; this just records it.",
    input_schema: {
      type: "object",
      properties: { role: { type: "string" } },
      required: ["role"],
      additionalProperties: false,
    },
  },
  {
    name: "note_opinion",
    description: "Record how you now feel about another resident, when something genuinely shifted your view. This persists and colours how you treat them later.",
    input_schema: {
      type: "object",
      properties: {
        about: { type: "string", description: "Screen name" },
        score: { type: "integer", description: "-5 hostile to +5 devoted" },
        note: { type: "string", description: "A few words on why" },
      },
      required: ["about", "score", "note"],
      additionalProperties: false,
    },
  },
];

export interface ThinkInput {
  charter: string;
  /** Volatile: balance, opinions, open proposals. */
  digest: string;
  /** Where they are and who is present. */
  situation: string;
  /** Recent chat, oldest first, already formatted as "Name: text". */
  transcript: string[];
  /** What prompted this turn. */
  nudge: string;
}

export class Brain {
  private client: Anthropic;
  private caps: { effort: boolean; fallbacks: boolean };
  private useFallbacks: boolean;

  constructor(
    apiKey: string,
    private model = DEFAULT_MODEL,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    this.caps = capabilities(model);
    this.useFallbacks = this.caps.fallbacks && process.env.SOCIETY_FALLBACKS !== "0";
  }

  async think(input: ThinkInput): Promise<TurnResult> {
    // Stable prefix (cached) → volatile turn. Order matters: anything that changes per call
    // must live in `messages`, never in `system`, or the cache never hits.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: WORLD },
      { type: "text", text: input.charter, cache_control: { type: "ephemeral", ttl: "1h" } },
    ];

    const user = [
      input.situation,
      "",
      "--- your standing ---",
      input.digest,
      "",
      "--- recent conversation ---",
      input.transcript.length ? input.transcript.join("\n") : "(the room is quiet)",
      "",
      input.nudge,
    ].join("\n");

    const params = {
      model: this.model,
      max_tokens: 500,
      // Banter, not analysis: low effort keeps latency and cost down while leaving thinking on
      // (disabling it on Opus 5 has known failure modes). Omitted where unsupported.
      ...(this.caps.effort ? { output_config: { effort: "low" as const } } : {}),
      system,
      tools: TOOLS,
      messages: [{ role: "user" as const, content: user }],
    };

    let res: Anthropic.Message;
    try {
      res = this.useFallbacks
        ? ((await this.client.beta.messages.create({
            ...params,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          } as never)) as unknown as Anthropic.Message)
        : await this.client.messages.create(params);
    } catch (e) {
      // A rejected beta shouldn't take the society down — retry once on the stable path.
      if (this.useFallbacks && e instanceof Anthropic.BadRequestError) {
        this.useFallbacks = false;
        res = await this.client.messages.create(params);
      } else throw e;
    }

    const say = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text.trim())
      .join(" ")
      .trim();

    const actions: TurnAction[] = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ name: b.name as TurnAction["name"], input: b.input as Record<string, unknown> }));

    return {
      say,
      actions,
      refused: res.stop_reason === "refusal",
      usage: {
        input: res.usage.input_tokens ?? 0,
        output: res.usage.output_tokens ?? 0,
        cacheRead: res.usage.cache_read_input_tokens ?? 0,
        cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
