/**
 * Model routing and the OpenAI-compatible translation layer.
 *
 * The network halves cannot be unit-tested, but everything that can silently corrupt a turn
 * or the books can: which client a model string goes to, how tools are translated, and how a
 * completion is read back into text, tool calls, and billable tokens.
 */
import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { fromOpenAI, isCredentialOrCreditError, modelFor, resolveModel, stripReasoning, toOpenAITools, trimToSentence, type ChatTool } from "./providers.js";
import { loadRemotePrices, priceOf } from "./budget.js";

const completion = (over: Record<string, unknown> = {}): OpenAI.Chat.Completions.ChatCompletion =>
  ({
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "hello", refusal: null } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    ...over,
  }) as OpenAI.Chat.Completions.ChatCompletion;

describe("resolveModel", () => {
  it("routes by the explicit prefix, never by guessing the vendor from the name", () => {
    expect(resolveModel("claude-haiku-4-5")).toEqual({ kind: "anthropic", model: "claude-haiku-4-5" });
    expect(resolveModel("oa:gpt-4o")).toEqual({ kind: "openai", model: "gpt-4o" });
    // The case the prefix exists for: an OpenRouter id that names Anthropic but is not the
    // Anthropic API. Guessing by vendor prefix would send this to the wrong client.
    expect(resolveModel("oa:anthropic/claude-3.5-sonnet")).toEqual({ kind: "openai", model: "anthropic/claude-3.5-sonnet" });
    expect(resolveModel("anthropic/claude-3.5-sonnet")).toEqual({ kind: "anthropic", model: "anthropic/claude-3.5-sonnet" });
  });
});

describe("modelFor", () => {
  it("prefers a per-resident override and ignores a blank one", () => {
    expect(modelFor("Raven", "claude-haiku-4-5", { SOCIETY_MODEL_RAVEN: "oa:z-ai/glm-4.6" } as NodeJS.ProcessEnv)).toBe("oa:z-ai/glm-4.6");
    expect(modelFor("Raven", "claude-haiku-4-5", { SOCIETY_MODEL_RAVEN: "  " } as NodeJS.ProcessEnv)).toBe("claude-haiku-4-5");
    expect(modelFor("Byte", "claude-haiku-4-5", {} as NodeJS.ProcessEnv)).toBe("claude-haiku-4-5");
  });
});

describe("toOpenAITools", () => {
  it("moves the schema across unchanged", () => {
    const tool: ChatTool = {
      name: "vote",
      description: "Vote on an open proposal.",
      input_schema: { type: "object", properties: { choice: { type: "string", enum: ["for", "against"] } }, required: ["choice"], additionalProperties: false },
    };
    expect(toOpenAITools([tool])).toEqual([{ type: "function", function: { name: "vote", description: "Vote on an open proposal.", parameters: tool.input_schema } }]);
  });
});

describe("fromOpenAI", () => {
  it("reads text and tool calls", () => {
    const r = fromOpenAI(
      completion({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            logprobs: null,
            message: {
              role: "assistant",
              content: "  voting against  ",
              refusal: null,
              tool_calls: [{ id: "1", type: "function", function: { name: "vote", arguments: '{"proposal_id":"p1","choice":"against"}' } }],
            },
          },
        ],
      }),
    );
    expect(r.text).toBe("voting against");
    expect(r.calls).toEqual([{ name: "vote", input: { proposal_id: "p1", choice: "against" } }]);
  });

  it("drops a malformed tool call but keeps the turn", () => {
    // A model that emits broken JSON costs itself a tool call, not the society its process.
    const r = fromOpenAI(
      completion({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            logprobs: null,
            message: {
              role: "assistant",
              content: "tipping Nova",
              refusal: null,
              tool_calls: [
                { id: "1", type: "function", function: { name: "send_bits", arguments: "{not json" } },
                { id: "2", type: "function", function: { name: "set_mood", arguments: '{"mood":"wry","why":"the registry"}' } },
              ],
            },
          },
        ],
      }),
    );
    expect(r.text).toBe("tipping Nova");
    expect(r.calls).toEqual([{ name: "set_mood", input: { mood: "wry", why: "the registry" } }]);
  });

  it("splits cached tokens out of the prompt total so the books stay honest", () => {
    // prompt_tokens INCLUDES cached tokens; counting both would bill the prefix twice.
    const r = fromOpenAI(completion({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 } } }));
    expect(r.usage).toEqual({ input: 20, output: 20, cacheRead: 80, cacheWrite: 0 });
  });

  it("recognises a refusal in either shape, and survives an empty response", () => {
    expect(fromOpenAI(completion({ choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: null, refusal: "no" } }] })).refused).toBe(true);
    expect(fromOpenAI(completion({ choices: [{ index: 0, finish_reason: "content_filter", logprobs: null, message: { role: "assistant", content: "", refusal: null } }] })).refused).toBe(true);
    const empty = fromOpenAI(completion({ choices: [], usage: undefined }));
    expect(empty).toEqual({ text: "", calls: [], refused: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  });
});

describe("isCredentialOrCreditError", () => {
  it("tells a dead key or an empty balance apart from an ordinary failure", () => {
    // OpenRouter answers 402 when a key hits its credit ceiling; that is the one we exist for.
    expect(isCredentialOrCreditError({ status: 402 })).toBe(true);
    expect(isCredentialOrCreditError({ status: 401 })).toBe(true);
    expect(isCredentialOrCreditError({ status: 403 })).toBe(true);
    // A bad request or a rate limit must NOT move a resident off their model permanently.
    expect(isCredentialOrCreditError({ status: 400 })).toBe(false);
    expect(isCredentialOrCreditError({ status: 429 })).toBe(false);
    expect(isCredentialOrCreditError({ status: 500 })).toBe(false);
    expect(isCredentialOrCreditError(new Error("socket hang up"))).toBe(false);
  });
});

describe("trimToSentence", () => {
  it("cuts a reply that ran out of room back to its last finished sentence", () => {
    // The real one: Marlowe posted "...you could hear a bit drop. Makes you" and stopped dead.
    expect(trimToSentence("Between us, it is so quiet you could hear a bit drop. Makes you")).toBe("Between us, it is so quiet you could hear a bit drop.");
    expect(trimToSentence("Really? Then who voted for it, exact")).toBe("Really?");
    // Nothing to cut back to: a fragment beats an empty message.
    expect(trimToSentence("no punctuation at all here")).toBe("no punctuation at all here");
  });
});

describe("fromOpenAI truncation", () => {
  const withFinish = (finish: string, content: string) =>
    fromOpenAI({
      id: "c", object: "chat.completion", created: 0, model: "m",
      choices: [{ index: 0, finish_reason: finish, logprobs: null, message: { role: "assistant", content, refusal: null } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as unknown as OpenAI.Chat.Completions.ChatCompletion);

  it("trims only when the model actually ran out of room", () => {
    expect(withFinish("length", "One good line. And a half").text).toBe("One good line.");
    // A normal stop may legitimately end without punctuation; leave it alone.
    expect(withFinish("stop", "One good line. And a half").text).toBe("One good line. And a half");
  });
});

describe("stripReasoning", () => {
  it("cuts reasoning blocks that some models put in the visible message", () => {
    // Observed from amazon/nova-lite during model selection.
    expect(stripReasoning("<thinking>Sterling weighs it up</thinking> Dark mode, obviously.")).toBe("Dark mode, obviously.");
    expect(stripReasoning("<think>a</think><think>b</think>  yes  ")).toBe("yes");
    // Truncated at the token limit: no closing tag, so drop the tail rather than post markup.
    expect(stripReasoning("<thinking>ran out of room")).toBe("");
    // Ordinary text with angle brackets is untouched.
    expect(stripReasoning("use <b>bold</b> if you like")).toBe("use <b>bold</b> if you like");
  });
});

describe("loadRemotePrices", () => {
  const catalogue = {
    data: [
      { id: "z-ai/glm-4.7-flash", pricing: { prompt: "0.00000006", completion: "0.0000004" } },
      { id: "broken/model", pricing: { prompt: "not-a-number", completion: "0.1" } },
    ],
  };
  const fakeFetch = (async () => ({ ok: true, json: async () => catalogue })) as unknown as typeof fetch;

  it("converts per-token prices to per-million and skips unparseable ones", async () => {
    expect(await loadRemotePrices("https://openrouter.ai/api/v1/", fakeFetch)).toBe(1);
    expect(priceOf("z-ai/glm-4.7-flash")).toEqual({ input: 0.06, output: 0.4 });
    expect(priceOf("broken/model")).toEqual({ input: 5, output: 25 });
  });

  it("lets an explicit env price override the gateway, and never lets a fetch failure pass silently", async () => {
    process.env.SOCIETY_MODEL_PRICES = JSON.stringify({ "z-ai/glm-4.7-flash": { input: 9, output: 9 } });
    expect(priceOf("z-ai/glm-4.7-flash")).toEqual({ input: 9, output: 9 });
    delete process.env.SOCIETY_MODEL_PRICES;
    const failing = (async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    await expect(loadRemotePrices("https://openrouter.ai/api/v1", failing)).rejects.toThrow(/502/);
  });
});

describe("priceOf", () => {
  it("prices a known model and charges the top tier for an unknown one", () => {
    expect(priceOf("claude-haiku-4-5")).toEqual({ input: 1, output: 5 });
    // Bits are backed by real dollars: an unpriced model must never look free.
    expect(priceOf("some/unlisted-model")).toEqual({ input: 5, output: 25 });
  });

  it("takes prices from the environment for models it does not ship with", () => {
    process.env.SOCIETY_MODEL_PRICES = JSON.stringify({ "z-ai/glm-4.6": { input: 0.4, output: 1.75 } });
    expect(priceOf("z-ai/glm-4.6")).toEqual({ input: 0.4, output: 1.75 });
    process.env.SOCIETY_MODEL_PRICES = "{ not json";
    expect(priceOf("another/unlisted")).toEqual({ input: 5, output: 25 });
    delete process.env.SOCIETY_MODEL_PRICES;
  });
});
