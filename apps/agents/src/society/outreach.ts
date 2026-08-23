/**
 * When a resident is allowed to message the human first.
 *
 * The default is silence. A DM requires a *reason* — something in the world genuinely changed
 * for that resident — plus a cooldown, because answering the human is the highest-paying act
 * in the economy and without a brake they would simply swarm the inbox for bits.
 *
 * Every trigger fires at most once per occasion. "Broke" re-arms only after they recover,
 * so it cannot nag.
 */
import type { World } from "./world.js";

export interface OutreachConfig {
  enabled: boolean;
  /** Minimum gap between DMs from the same resident. */
  perResidentCooldownMs: number;
  /** Minimum gap between DMs from anyone, so eight residents cannot pile in at once. */
  globalCooldownMs: number;
  /** Balance under which a resident may reasonably raise the alarm. */
  brokeAt: number;
  /** Opinion strength that counts as worth mentioning. */
  strongOpinion: number;
}

export function outreachConfig(): OutreachConfig {
  return {
    enabled: process.env.SOCIETY_DM_HUMAN !== "0",
    perResidentCooldownMs: Number(process.env.SOCIETY_DM_COOLDOWN_MIN ?? 60) * 60_000,
    globalCooldownMs: Number(process.env.SOCIETY_DM_GLOBAL_GAP_MIN ?? 8) * 60_000,
    brokeAt: Number(process.env.SOCIETY_DM_BROKE_AT ?? 12),
    strongOpinion: Number(process.env.SOCIETY_DM_OPINION_AT ?? 4),
  };
}

interface ResidentState {
  lastDmAt: number;
  /** Occasions already used, so a trigger cannot repeat. */
  used: Set<string>;
  /** True once they have recovered, which re-arms the broke trigger. */
  solventSince: boolean;
}

export class Outreach {
  private state = new Map<string, ResidentState>();
  private lastAnyDmAt = 0;

  constructor(private cfg: OutreachConfig) {}

  /**
   * Restore what a resident has already said, so a restart is not a fresh start.
   *
   * This lived only in memory, and every deploy wiped it. Raven told the human five separate
   * times that she thought well of Coach - not because she was nagging, but because each
   * restart re-armed a one-shot trigger. State that governs "have I already said this" has to
   * outlive the process saying it.
   */
  hydrate(name: string, saved: { lastDmAt?: number; used?: string[] } | undefined) {
    if (!saved) return;
    const s = this.stateFor(name);
    s.lastDmAt = Math.max(s.lastDmAt, Number(saved.lastDmAt ?? 0));
    for (const k of saved.used ?? []) s.used.add(k);
    this.lastAnyDmAt = Math.max(this.lastAnyDmAt, s.lastDmAt);
  }

  /** The part worth persisting, small enough to sit on a profile. */
  snapshot(name: string): { lastDmAt: number; used: string[] } {
    const s = this.stateFor(name);
    return { lastDmAt: s.lastDmAt, used: [...s.used].slice(-40) };
  }

  private stateFor(name: string): ResidentState {
    let s = this.state.get(name);
    if (!s) {
      s = { lastDmAt: 0, used: new Set(), solventSince: true };
      this.state.set(name, s);
    }
    return s;
  }

  /**
   * Why this resident should message the human right now, or undefined for "no reason —
   * stay quiet". The returned string is handed to the model as its motivation.
   */
  reasonFor(name: string, world: World): { key: string; nudge: string } | undefined {
    if (!this.cfg.enabled) return undefined;
    const now = Date.now();
    if (now - this.lastAnyDmAt < this.cfg.globalCooldownMs) return undefined;
    const s = this.stateFor(name);
    if (now - s.lastDmAt < this.cfg.perResidentCooldownMs) return undefined;

    const balance = world.balance(name);

    // Running out of money is the most human reason to get in touch.
    if (balance < this.cfg.brokeAt) {
      if (s.solventSince && !s.used.has("broke")) {
        return {
          key: "broke",
          nudge: `You are down to ${balance} bits and will shortly be unable to speak at all. You have decided to message the human about it. Do it in your own way — some of you would ask plainly, some would negotiate, some would be too proud to ask and would talk around it. Do not grovel and do not pretend it is fine.`,
        };
      }
    } else if (!s.solventSince) {
      // Recovered — the alarm can be raised again if they fall back.
      s.solventSince = true;
      s.used.delete("broke");
    }

    // A proposal of yours carried and the human is the one who can actually ship it.
    for (const p of world.proposals.values()) {
      if (p.author !== name || p.status !== "passed") continue;
      // Already built — pitching it again would be asking for work that is done.
      if (world.shipped.has(p.id)) continue;
      const key = `passed:${p.id}`;
      if (s.used.has(key)) continue;
      return {
        key,
        nudge: `Your proposal "${p.title}" passed the vote. The human is the one who can actually implement it. Message them about it — make the case, or just tell them, depending on who you are.`,
      };
    }

    // A strong view of someone else, which is exactly the sort of thing people share privately.
    const mine = world.opinions.get(name);
    if (mine) {
      for (const [about, o] of mine) {
        if (Math.abs(o.score) < this.cfg.strongOpinion) continue;
        const key = `opinion:${about}:${o.score > 0 ? "+" : "-"}`;
        if (s.used.has(key)) continue;
        return {
          key,
          nudge: `You have formed a strong view of ${about} (${o.score > 0 ? "+" : ""}${o.score}: ${o.note}). You have decided to mention it to the human privately. Whether that is loyalty, a warning, or gossip is up to you.`,
        };
      }
    }

    return undefined;
  }

  /** Record that a DM was sent, so cooldowns and one-shot triggers take effect. */
  record(name: string, key: string, world: World) {
    const s = this.stateFor(name);
    s.lastDmAt = Date.now();
    s.used.add(key);
    if (key === "broke") s.solventSince = false;
    this.lastAnyDmAt = Date.now();
    void world;
  }

  get status() {
    return {
      enabled: this.cfg.enabled,
      per_resident_cooldown_min: Math.round(this.cfg.perResidentCooldownMs / 60_000),
      global_gap_min: Math.round(this.cfg.globalCooldownMs / 60_000),
      last_dm_minutes_ago: this.lastAnyDmAt ? Math.round((Date.now() - this.lastAnyDmAt) / 60_000) : null,
    };
  }
}
