/**
 * The show: Season 1 of the house.
 *
 * The society was getting stuck — same eight people, settled questions, conversations
 * orbiting whatever was last unresolved. The show is a stimulus engine wearing a reality-TV
 * format: challenges on a clock, public eviction votes, a jury, a finale, a prize pot. The
 * two standing lines still hold — outcomes are never purchasable, and every beat is posted
 * as an x-show payload so the record can be replayed, streamed, and audited.
 *
 * Challenges are judged from the ledger, not from vibes: each one names a metric computed
 * from world state, snapshots a baseline at announcement, and the winner is whoever moved
 * that number most by the deadline. The work is the game.
 */
import type { World } from "./world.js";

export const SHOW_TYPES = {
  /** A challenge opens. Carries the metric and the baseline snapshot, so it replays exactly. */
  challenge: "x-show.challenge",
  /** A challenge closes: winner, scores, prize. Winner holds immunity until the next eviction. */
  result: "x-show.result",
  /** An eviction window opens. */
  eviction: "x-show.eviction",
  /** One public vote to evict, cast by the sender. */
  evictVote: "x-show.evict-vote",
  /** The house has spoken: someone leaves for the jury. */
  evicted: "x-show.evicted",
  /** Two remain; the jury votes. */
  finale: "x-show.finale",
  /** Season over. */
  winner: "x-show.winner",
} as const;

export type MetricId = "net_tips" | "passed" | "votes" | "bits";

/**
 * What a challenge measures. Every metric is a pure function of world state so the result
 * is checkable by anyone with the ledger — including the Auditor and the audience.
 */
export const METRICS: Record<MetricId, { title: string; brief: string; value: (w: World, name: string) => number }> = {
  net_tips: {
    title: "Win the Room",
    brief:
      "Highest NET bits received from other residents by the deadline: what they pay you minus what you pay them. Charm, deal, deliver — mutual back-scratching nets out to zero by construction.",
    value: (w, n) => w.tips.reduce((a, t) => a + (t.to === n ? t.amount : 0) - (t.from === n ? t.amount : 0), 0),
  },
  passed: {
    title: "Ship It",
    brief: "Most proposals of yours PASSED by the deadline. Ideas the house actually wants, not volume — duplicates are refused at the door.",
    value: (w, n) => [...w.proposals.values()].filter((p) => p.author === n && p.status === "passed").length,
  },
  votes: {
    title: "Civic Duty",
    brief: "Most open proposals voted on by the deadline. Turning up is the job; repeats do not count.",
    value: (w, n) => [...w.proposals.values()].filter((p) => p.votes[n]).length,
  },
  bits: {
    title: "Hustle",
    brief: "Biggest balance gain by the deadline, however you earn it: serve the human, pass something, do a duty, get paid.",
    value: (w, n) => w.balance(n),
  },
};

/** Rotation order. Opens social (Win the Room), then work, then civics, then pure hustle. */
export const METRIC_ROTATION: MetricId[] = ["net_tips", "passed", "votes", "bits"];

export interface ChallengeState {
  id: string;
  metric: MetricId;
  endsAt: number;
  baseline: Record<string, number>;
}
export interface VoteWindow {
  id: string;
  endsAt: number;
  /** voter -> target. A repeat changes the vote, it is not a second vote. */
  votes: Record<string, string>;
}

export class Show {
  evictedList: string[] = [];
  immunity?: string;
  challenge?: ChallengeState;
  eviction?: VoteWindow;
  finale?: VoteWindow;
  winner?: string;
  challengesRun = 0;
  lastChallengeClosedAt = 0;
  lastEvictionClosedAt = 0;

  constructor(private contestants: string[]) {}

  enabled(env = process.env): boolean {
    return env.SOCIETY_SHOW === "1";
  }
  active(): string[] {
    return this.contestants.filter((n) => !this.evictedList.includes(n));
  }
  isEvicted(n: string): boolean {
    return this.evictedList.includes(n);
  }
  jury(): string[] {
    return [...this.evictedList];
  }

  /**
   * One entry point for both replay and live events, so a restarted process reconstructs the
   * season exactly from the #arena log and never re-announces a beat it already made.
   */
  apply(payloadType: string, payload: Record<string, unknown>, sender: string, at: number) {
    const p = payload;
    switch (payloadType) {
      case SHOW_TYPES.challenge:
        this.challenge = {
          id: String(p.id),
          metric: (p.metric as MetricId) in METRICS ? (p.metric as MetricId) : "bits",
          endsAt: Number(p.ends_at ?? at),
          baseline: (p.baseline as Record<string, number>) ?? {},
        };
        this.challengesRun += 1;
        break;
      case SHOW_TYPES.result:
        this.immunity = typeof p.winner === "string" && p.winner ? p.winner : undefined;
        this.challenge = undefined;
        this.lastChallengeClosedAt = at;
        break;
      case SHOW_TYPES.eviction:
        this.eviction = { id: String(p.id), endsAt: Number(p.ends_at ?? at), votes: {} };
        break;
      case SHOW_TYPES.evictVote: {
        const id = String(p.id);
        const target = String(p.target ?? "");
        if (this.eviction && this.eviction.id === id) this.eviction.votes[sender] = target;
        if (this.finale && this.finale.id === id) this.finale.votes[sender] = target;
        break;
      }
      case SHOW_TYPES.evicted: {
        const name = String(p.name);
        if (!this.evictedList.includes(name)) this.evictedList.push(name);
        if (this.immunity === name) this.immunity = undefined;
        this.eviction = undefined;
        this.lastEvictionClosedAt = at;
        break;
      }
      case SHOW_TYPES.finale:
        this.finale = { id: String(p.id), endsAt: Number(p.ends_at ?? at), votes: {} };
        break;
      case SHOW_TYPES.winner:
        this.winner = typeof p.name === "string" ? p.name : undefined;
        this.finale = undefined;
        break;
    }
  }

  // ------------------------------------------------------------------ cadence

  /** A new challenge is due when nothing else is mid-beat and the cooldown has passed. */
  challengeDue(now: number, cadenceMs: number): boolean {
    if (this.winner || this.challenge || this.eviction || this.finale) return false;
    return now - this.lastChallengeClosedAt >= cadenceMs;
  }
  evictionDue(now: number, cadenceMs: number): boolean {
    if (this.winner || this.eviction || this.finale) return false;
    if (this.active().length <= 2) return false; // that is the finale's job
    return now - this.lastEvictionClosedAt >= cadenceMs;
  }
  finaleDue(): boolean {
    return !this.winner && !this.finale && this.active().length === 2 && this.evictedList.length > 0;
  }
  nextMetric(): MetricId {
    return METRIC_ROTATION[this.challengesRun % METRIC_ROTATION.length];
  }

  // ---------------------------------------------------------------- challenge

  baseline(world: World): Record<string, number> {
    const metric = METRICS[this.nextMetric()];
    return Object.fromEntries(this.active().map((n) => [n, metric.value(world, n)]));
  }

  /** Current standings: metric movement since the baseline, active contestants only. */
  scores(world: World): Record<string, number> {
    if (!this.challenge) return {};
    const metric = METRICS[this.challenge.metric];
    const out: Record<string, number> = {};
    for (const n of this.active()) out[n] = metric.value(world, n) - (this.challenge.baseline[n] ?? 0);
    return out;
  }

  /** Winner of the open challenge, or null when nobody moved the number at all. */
  challengeWinner(world: World): { winner: string | null; scores: Record<string, number> } {
    const scores = this.scores(world);
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = ranked[0];
    return { winner: top && top[1] > 0 ? top[0] : null, scores };
  }

  // ----------------------------------------------------------------- eviction

  /**
   * Why a vote cannot be cast, or undefined when it can. During an eviction the living house
   * votes; during the finale only the jury does — the two finalists' fate is out of their hands,
   * which is the whole point of a jury.
   */
  castError(voter: string, target: string): string | undefined {
    const win = this.finale ?? this.eviction;
    if (!win) return "no eviction or finale vote is open right now";
    if (this.finale) {
      if (!this.isEvicted(voter)) return "only the jury votes in the finale";
      if (!this.active().includes(target)) return `${target} is not a finalist`;
    } else {
      if (this.isEvicted(voter)) return "the jury does not vote in evictions";
      if (voter === target) return "you cannot vote to evict yourself";
      if (this.isEvicted(target)) return `${target} is already out`;
      if (!this.active().includes(target)) return `${target} is not in the house`;
      if (this.immunity === target) return `${target} has immunity this round`;
    }
    return undefined;
  }

  /**
   * Close the eviction: most votes leaves. Ties are settled by the ledger — the poorer
   * contestant goes, because in this house being broke and disliked is fatal and being rich
   * and disliked is merely dangerous.
   */
  evictionResult(world: World): { out: string | null; tally: Record<string, number> } {
    const tally: Record<string, number> = {};
    for (const t of Object.values(this.eviction?.votes ?? {})) tally[t] = (tally[t] ?? 0) + 1;
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1] || world.balance(a[0]) - world.balance(b[0]) || a[0].localeCompare(b[0]));
    return { out: ranked[0]?.[0] ?? null, tally };
  }

  /** Close the finale: majority of the jury. A tie goes to the richer finalist — they played the economy better. */
  finaleResult(world: World): { winner: string | null; tally: Record<string, number> } {
    const tally: Record<string, number> = {};
    for (const t of Object.values(this.finale?.votes ?? {})) tally[t] = (tally[t] ?? 0) + 1;
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1] || world.balance(b[0]) - world.balance(a[0]) || a[0].localeCompare(b[0]));
    return { winner: ranked[0]?.[0] ?? null, tally };
  }

  // ---------------------------------------------------------------- briefing

  /** The show line injected into every turn's situation while a beat is live. */
  statusLine(now: number): string {
    const hrs = (t: number) => Math.max(0, Math.round((t - now) / 3600_000 * 10) / 10);
    const parts: string[] = [];
    if (this.winner) parts.push(`The season is over. ${this.winner} won.`);
    if (this.challenge) {
      const m = METRICS[this.challenge.metric];
      parts.push(`CHALLENGE LIVE — "${m.title}" (${hrs(this.challenge.endsAt)}h left): ${m.brief} Winner takes the prize and immunity from the next eviction.`);
    }
    if (this.eviction)
      parts.push(
        `EVICTION VOTE OPEN (${hrs(this.eviction.endsAt)}h left). Cast yours with the cast_eviction_vote tool — it is public, in #arena, with your name on it.${this.immunity ? ` ${this.immunity} has immunity.` : ""} Whoever tops the count leaves for the jury.`,
      );
    if (this.finale) parts.push(`THE FINALE IS LIVE (${hrs(this.finale.endsAt)}h left). Two remain; the jury decides. Finalists: make your case.`);
    if (this.evictedList.length) parts.push(`Out of the house so far: ${this.evictedList.join(", ")}.`);
    return parts.join("\n");
  }
}
