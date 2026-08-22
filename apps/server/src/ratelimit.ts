/** Token bucket per user, plus AIM-style warning level (0-100) that tightens limits. */
import type { Db } from "./db.js";

interface Bucket {
  tokens: number;
  updated: number;
}

export function rateLimiter(db: Db, opts: { perMinute: number; burst: number }) {
  const buckets = new Map<string, Bucket>();
  const warn = new Map<string, { level: number; updated: number; timeoutUntil: number }>();

  function warnState(id: string, initial: number) {
    const now = Date.now();
    const w = warn.get(id) ?? { level: initial, updated: now, timeoutUntil: 0 };
    // decay 10 points per hour
    w.level = Math.max(0, w.level - ((now - w.updated) / 3_600_000) * 10);
    w.updated = now;
    warn.set(id, w);
    return w;
  }

  /** Returns undefined if allowed, otherwise a reason. */
  function check(userId: string, initialWarn: number): { allowed: true; level: number } | { allowed: false; level: number; reason: string } {
    const now = Date.now();
    const w = warnState(userId, initialWarn);
    if (w.timeoutUntil > now) return { allowed: false, level: w.level, reason: `timed out for ${Math.ceil((w.timeoutUntil - now) / 1000)}s` };
    const factor = w.level > 50 ? 0.5 : 1;
    const perMin = opts.perMinute * factor;
    const burst = Math.max(1, Math.floor(opts.burst * factor));
    const b = buckets.get(userId) ?? { tokens: burst, updated: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.updated) / 60_000) * perMin);
    b.updated = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      buckets.set(userId, b);
      return { allowed: true, level: w.level };
    }
    buckets.set(userId, b);
    w.level = Math.min(100, w.level + 5);
    if (w.level >= 90) w.timeoutUntil = now + 15 * 60_000;
    void db.query("UPDATE users SET warn_level=$2 WHERE id=$1", [userId, w.level]);
    return { allowed: false, level: w.level, reason: "rate limit exceeded" };
  }

  async function manualWarn(userId: string, initial: number, amount = 10) {
    const w = warnState(userId, initial);
    w.level = Math.min(100, w.level + amount);
    await db.query("UPDATE users SET warn_level=$2 WHERE id=$1", [userId, w.level]);
    return w.level;
  }

  return { check, manualWarn };
}
export type RateLimiter = ReturnType<typeof rateLimiter>;
