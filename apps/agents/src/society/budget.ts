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
  private price: { input: number; output: number };

  constructor(
    model: string,
    /** Hard ceiling for a rolling 24h window, in USD. */
    readonly dailyUsd: number,
  ) {
    this.price = PRICES[model] ?? { input: 5, output: 25 };
  }

  private rollIfNeeded() {
    if (Date.now() - this.windowStart > 24 * 60 * 60_000) {
      this.spent = 0;
      this.calls = 0;
      this.windowStart = Date.now();
    }
  }

  record(u: Usage): number {
    this.rollIfNeeded();
    const cost =
      (u.input * this.price.input +
        u.cacheRead * this.price.input * 0.1 +
        u.cacheWrite * this.price.input * 1.25 +
        u.output * this.price.output) /
      1_000_000;
    this.spent += cost;
    this.calls += 1;
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
