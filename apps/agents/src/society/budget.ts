/**
 * Spend guard.
 *
 * A society that talks continuously will spend real money, and the failure mode nobody wants
 * is discovering that after the fact. This tracks actual token usage against published prices,
 * paces the world to hit a daily dollar target, and halts it outright at the cap.
 *
 * Prices are per million tokens. Cache reads bill at ~10% of input, cache writes at ~125%.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Prices for models this table does not ship with, as JSON, per million tokens:
 *
 *   SOCIETY_MODEL_PRICES={"z-ai/glm-4.6":{"input":0.4,"output":1.75}}
 *
 * Keys are the bare model id, without the `oa:` routing prefix.
 */
function envPrices(): Record<string, { input: number; output: number }> {
  const raw = process.env.SOCIETY_MODEL_PRICES;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, { input: number; output: number }>;
  } catch {
    console.warn("[budget] SOCIETY_MODEL_PRICES is not valid JSON; ignoring it");
    return {};
  }
}

/**
 * A priced model, or a deliberately pessimistic guess.
 *
 * Bits are backed by real dollars, so an unpriced model must never look free: guessing low
 * would let the society outspend its cap and would quietly under-charge for speech. The
 * fallback is the most expensive tier, and it says so once per model rather than every call.
 */
const FALLBACK_PRICE = { input: 5, output: 25 };
const warned = new Set<string>();
export function priceOf(model: string): { input: number; output: number } {
  const price = PRICES[model] ?? envPrices()[model];
  if (price) return price;
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(`[budget] no price for "${model}"; charging the top tier ($${FALLBACK_PRICE.input}/$${FALLBACK_PRICE.output} per Mtok). Set SOCIETY_MODEL_PRICES to correct it.`);
  }
  return FALLBACK_PRICE;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export class Budget {
  private spent = 0;
  private calls = 0;
  private windowStart = Date.now();
  /** Spend per model, so a mixed-model society can be read apart. */
  private byModel = new Map<string, number>();

  constructor(
    /** The society default, used when a call does not name its model. */
    private defaultModel: string,
    /** Hard ceiling for a rolling 24h window, in USD. */
    readonly dailyUsd: number,
  ) {}

  private rollIfNeeded() {
    if (Date.now() - this.windowStart > 24 * 60 * 60_000) {
      this.spent = 0;
      this.calls = 0;
      this.byModel.clear();
      this.windowStart = Date.now();
    }
  }

  /** Price a call against the model that actually served it, not the society default. */
  record(u: Usage, model = this.defaultModel): number {
    this.rollIfNeeded();
    const price = priceOf(model);
    const cost =
      (u.input * price.input + u.cacheRead * price.input * 0.1 + u.cacheWrite * price.input * 1.25 + u.output * price.output) / 1_000_000;
    this.spent += cost;
    this.calls += 1;
    this.byModel.set(model, (this.byModel.get(model) ?? 0) + cost);
    return cost;
  }

  get exhausted() {
    this.rollIfNeeded();
    return this.spent >= this.dailyUsd;
  }
  get status() {
    this.rollIfNeeded();
    return {
      spent_usd: Number(this.spent.toFixed(4)),
      daily_cap_usd: this.dailyUsd,
      calls: this.calls,
      remaining_usd: Number(Math.max(0, this.dailyUsd - this.spent).toFixed(4)),
      avg_cost_per_call: this.calls ? Number((this.spent / this.calls).toFixed(5)) : 0,
      by_model: Object.fromEntries([...this.byModel].map(([m, v]) => [m, Number(v.toFixed(4))])),
      window_resets_in_minutes: Math.round((24 * 60 * 60_000 - (Date.now() - this.windowStart)) / 60_000),
    };
  }

  /**
   * Seconds to wait before the next turn so the remaining budget lasts the rest of the window.
   * Before any call is measured we cannot know the real rate, so fall back to the floor.
   */
  paceSeconds(floorSeconds: number): number {
    this.rollIfNeeded();
    if (this.calls === 0) return floorSeconds;
    const avg = this.spent / this.calls;
    if (avg <= 0) return floorSeconds;
    const remainingUsd = Math.max(0, this.dailyUsd - this.spent);
    const remainingMs = 24 * 60 * 60_000 - (Date.now() - this.windowStart);
    const affordableCalls = remainingUsd / avg;
    if (affordableCalls < 1) return Math.max(floorSeconds, remainingMs / 1000);
    return Math.max(floorSeconds, remainingMs / 1000 / affordableCalls);
  }
}
