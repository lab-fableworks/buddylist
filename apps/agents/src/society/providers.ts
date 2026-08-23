/**
 * Which model a resident thinks with.
 *
 * The society was built on Claude and still defaults to it, but nothing about a resident
 * requires one vendor — and a room where Raven and Byte run on different models is a more
 * interesting room, because the voices genuinely differ rather than being two prompts over
 * one model. This is the seam that allows it.
 *
 * Two providers cover essentially everything: Anthropic natively, and one OpenAI-compatible
 * client that speaks to OpenRouter, OpenAI, Groq, DeepSeek, Together, and a local Ollama or
 * LM Studio without changing a line. A model is routed by an explicit `oa:` prefix rather
 * than by guessing from the name — OpenRouter ids look like `anthropic/claude-3.5-sonnet`,
 * so guessing by vendor prefix would send those to the wrong client.
 *
 *   SOCIETY_MODEL=claude-haiku-4-5              the society default, as before
 *   SOCIETY_MODEL_RAVEN=oa:z-ai/glm-4.6         one resident, elsewhere
 *   SOCIETY_OPENAI_BASE_URL=https://openrouter.ai/api/v1
 *   SOCIETY_OPENAI_API_KEY=...
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Usage } from "./budget.js";

/** Marks a model as belonging to the OpenAI-compatible client. */
export const OPENAI_PREFIX = "oa:";

export interface ChatTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface ChatCall {
  name: string;
  input: Record<string, unknown>;
}
export interface ChatResult {
  text: string;
  calls: ChatCall[];
  usage: Usage;
  refused: boolean;
}
export interface ChatRequest {
  /** System blocks in order. `cache` marks the last stable block, where supported. */
  system: Array<{ text: string; cache?: boolean }>;
  user: string;
  tools: ChatTool[];
  maxTokens: number;
}

export interface Provider {
  readonly kind: "anthropic" | "openai";
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

/** Splits a configured model string into the client that serves it and the id to send. */
export function resolveModel(spec: string): { kind: "anthropic" | "openai"; model: string } {
  return spec.startsWith(OPENAI_PREFIX)
    ? { kind: "openai", model: spec.slice(OPENAI_PREFIX.length) }
    : { kind: "anthropic", model: spec };
}

/** Per-resident override, falling back to the society default. `SOCIETY_MODEL_RAVEN=oa:...` */
export function modelFor(screenName: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[`SOCIETY_MODEL_${screenName.toUpperCase()}`]?.trim() || fallback;
}

// ------------------------------------------------------------------ Anthropic

/**
 * Not every model accepts every parameter, and sending an unsupported one is a hard 400.
 * `output_config.effort` errors on Haiku 4.5 and Sonnet 4.5; the server-side refusal
 * `fallbacks` parameter exists only on Fable 5 and Opus 5.
 */
export function capabilities(model: string) {
  const effortModels = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)$/;
  const fallbackModels = /^claude-(fable-5|mythos-5|opus-5)$/;
  return { effort: effortModels.test(model), fallbacks: fallbackModels.test(model) };
}

export class AnthropicProvider implements Provider {
  readonly kind = "anthropic" as const;
  private client: Anthropic;
  private caps: { effort: boolean; fallbacks: boolean };
  private useFallbacks: boolean;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    this.caps = capabilities(model);
    this.useFallbacks = this.caps.fallbacks && process.env.SOCIETY_FALLBACKS !== "0";
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const system: Anthropic.TextBlockParam[] = req.system.map((b) => ({
      type: "text",
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : {}),
    }));
    const params = {
      model: this.model,
      max_tokens: req.maxTokens,
      // Banter, not analysis: low effort keeps latency and cost down while leaving thinking on
      // (disabling it on Opus 5 has known failure modes). Omitted where unsupported.
      ...(this.caps.effort ? { output_config: { effort: "low" as const } } : {}),
      system,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool["input_schema"] })),
      messages: [{ role: "user" as const, content: req.user }],
    };

    let res: Anthropic.Message;
    try {
      res = this.useFallbacks
        ? ((await this.client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as never)) as unknown as Anthropic.Message)
        : await this.client.messages.create(params);
    } catch (e) {
      // A rejected beta shouldn't take the society down — retry once on the stable path.
      if (this.useFallbacks && e instanceof Anthropic.BadRequestError) {
        this.useFallbacks = false;
        res = await this.client.messages.create(params);
      } else throw e;
    }

    return {
      text: res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text.trim())
        .join(" ")
        .trim(),
      calls: res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ name: b.name, input: b.input as Record<string, unknown> })),
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

// ------------------------------------------------------------ OpenAI-compatible

/** Anthropic tool shape -> OpenAI function shape. The schemas themselves are identical JSON Schema. */
export function toOpenAITools(tools: ChatTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema as Record<string, unknown> },
  }));
}

/**
 * Some models narrate their reasoning inside the visible message rather than in a separate
 * field. Observed from amazon/nova-lite, which opens with a literal `<thinking>` block. In a
 * chat room that lands as raw markup, so it is cut here rather than left to the narration
 * guard, which is looking for prose and would not recognise it.
 */
/** Deliberately no backreference: <think> closed by </thinking> has still shown its working. */
const REASONING_BLOCK = /<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi;
/** An unclosed opener means the block ran to the token limit; drop the remainder. */
const REASONING_OPEN = /<(?:think|thinking|reasoning)>[\s\S]*$/i;

export function stripReasoning(text: string): string {
  // Plain regex literals on purpose: in a template literal `\s` collapses to a literal "s",
  // which would silently match the wrong thing.
  return text.replace(REASONING_BLOCK, "").replace(REASONING_OPEN, "").trim();
}

/**
 * Read one completion back into the shape the society already understands.
 *
 * Tool arguments arrive as a JSON *string*. A model that emits malformed JSON must lose its
 * tool call, not take the process down — the turn still has its words, and a dropped tool
 * call is a bad turn rather than a dead society.
 */
export function fromOpenAI(res: OpenAI.Chat.Completions.ChatCompletion): ChatResult {
  const choice = res.choices[0];
  const msg = choice?.message;
  const calls: ChatCall[] = [];
  for (const c of msg?.tool_calls ?? []) {
    if (c.type !== "function") continue;
    try {
      const parsed = JSON.parse(c.function.arguments || "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) calls.push({ name: c.function.name, input: parsed as Record<string, unknown> });
    } catch {
      /* malformed arguments: drop the call, keep the turn */
    }
  }
  const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: stripReasoning(msg?.content ?? ""),
    calls,
    // `refusal` is the structured form; content_filter is what most compatible servers send.
    refused: !!msg?.refusal || choice?.finish_reason === "content_filter",
    usage: {
      // prompt_tokens includes cached tokens; splitting them keeps the cost maths honest.
      input: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached),
      output: res.usage?.completion_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: 0,
    },
  };
}

export class OpenAICompatProvider implements Provider {
  readonly kind = "openai" as const;
  private client: OpenAI;

  constructor(
    readonly model: string,
    opts: { baseURL?: string; apiKey?: string } = {},
  ) {
    const baseURL = opts.baseURL ?? process.env.SOCIETY_OPENAI_BASE_URL;
    // A local Ollama or LM Studio needs no key; a hosted gateway does. Only the URL is required.
    const apiKey = opts.apiKey ?? process.env.SOCIETY_OPENAI_API_KEY ?? "not-needed";
    if (!baseURL) throw new Error(`model "${OPENAI_PREFIX}${model}" needs SOCIETY_OPENAI_BASE_URL (e.g. https://openrouter.ai/api/v1)`);
    this.client = new OpenAI({ baseURL, apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    // No cache_control: prefix caching on these providers is automatic or absent, never asked
    // for. The stable-prefix ordering still helps wherever it is automatic.
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system.map((b) => b.text).join("\n\n") },
        { role: "user", content: req.user },
      ],
      tools: toOpenAITools(req.tools),
    });
    return fromOpenAI(res);
  }
}

/**
 * A gateway saying "no key" or "no money" - as opposed to a bad request or a hiccup.
 * OpenRouter answers 402 when a key hits its credit limit, which is a certainty, not a risk:
 * every key has a ceiling and this society talks until it finds it.
 */
export function isCredentialOrCreditError(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status === 401 || status === 402 || status === 403;
}

/** Build the client for a configured model string. */
export function providerFor(spec: string, anthropicKey: string): Provider {
  const { kind, model } = resolveModel(spec);
  return kind === "openai" ? new OpenAICompatProvider(model) : new AnthropicProvider(anthropicKey, model);
}
