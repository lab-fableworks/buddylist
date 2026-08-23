/**
 * The thinking half of a citizen: one model call per turn.
 *
 * Which model is providers.ts's business — Claude by default, anything OpenAI-compatible per
 * resident. This module owns the prompt, the tools, and the shape of a turn.
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
import { WORLD } from "./citizens.js";
import { AnthropicProvider, type ChatTool, isCredentialOrCreditError, type Provider, providerFor } from "./providers.js";
import type { Usage } from "./budget.js";

export const DEFAULT_MODEL = process.env.SOCIETY_MODEL ?? "claude-opus-5";

export interface TurnAction {
  name: "send_bits" | "propose" | "vote" | "note_opinion" | "set_mood" | "relate" | "take_role" | "resign_role";
  input: Record<string, unknown>;
}
export interface TurnResult {
  say: string;
  actions: TurnAction[];
  usage: Usage;
  refused: boolean;
}

/** Identical for every citizen so it stays part of the shared cache prefix. */
const TOOLS: ChatTool[] = [
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
    description:
      "Put a concrete proposal to the society. Use only for a real idea, not a passing remark. Your briefing lists what is already on the record - check it first, because a duplicate costs you bits and gets voted down. If it concerns the BuddyList software itself, set software=true and be specific enough that a developer could act on it.",
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
  private provider: Provider;

  constructor(
    private apiKey: string,
    model = DEFAULT_MODEL,
  ) {
    this.provider = providerFor(model, apiKey);
  }

  /**
   * The model actually in use — a getter, not a snapshot, because a resident can be moved to
   * the fallback mid-life and the budget must price what really served the call.
   */
  get model(): string {
    return this.provider.model;
  }

  /**
   * When the gateway is out of credit or the key is rejected, move this resident home to
   * Anthropic for the rest of the process. A society that goes silent because one prepaid key
   * ran dry is a worse outcome than one that quietly costs a little on the account that still
   * works — and the daily budget cap still binds either way. Returns true if it switched.
   */
  private fallHome(): boolean {
    if (this.provider.kind !== "openai") return false;
    const lost = this.provider.model;
    this.provider = new AnthropicProvider(this.apiKey, DEFAULT_MODEL);
    console.warn(`[society] gateway refused "${lost}" (no key or no credit); falling back to ${DEFAULT_MODEL}`);
    return true;
  }

  async think(input: ThinkInput): Promise<TurnResult> {
    // Stable prefix (cached) -> volatile turn. Order matters: anything that changes per call
    // must live in the user turn, never in the system blocks, or the cache never hits.
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

    const req = { system: [{ text: WORLD }, { text: input.charter, cache: true }], user, tools: TOOLS, maxTokens: 500 };
    let res;
    try {
      res = await this.provider.chat(req);
    } catch (e) {
      // One retry, and only after actually switching provider — otherwise this is a loop.
      if (!isCredentialOrCreditError(e) || !this.fallHome()) throw e;
      res = await this.provider.chat(req);
    }

    return {
      say: res.text,
      actions: res.calls.map((c) => ({ name: c.name as TurnAction["name"], input: c.input })),
      refused: res.refused,
      usage: res.usage,
    };
  }
}
