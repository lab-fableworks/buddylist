/**
 * Sleep, breaks, and noticing whether anyone is around.
 *
 * Eight residents awake around the clock is neither believable nor cheap. Each one keeps their
 * own rhythm: hours they tend to be up, and breaks they take during them. A resident on a break
 * is genuinely gone — skipped for spontaneous turns, presence set away — but a direct message
 * from a human wakes them, the way a phone does.
 *
 * The society also watches whether the human is around, and goes quiet when nobody is.
 */

export interface Rhythm {
  /** Hours (UTC, 0-23) this resident tends to be awake. Wraps past midnight. */
  awake: [number, number];
  /** Chance per turn of starting a break while awake. */
  breakChance: number;
  /** Things they say they are doing while away. */
  doing: string[];
}

/** Personality-linked schedules — Raven is nocturnal, Coach is up at dawn. */
export const RHYTHMS: Record<string, Rhythm> = {
  Raven: { awake: [19, 7], breakChance: 0.1, doing: ["out walking", "reading something old", "watching the light change"] },
  Byte: { awake: [10, 3], breakChance: 0.12, doing: ["deep in a codebase", "chasing a bug", "reading the spec again"] },
  Objection: { awake: [8, 19], breakChance: 0.08, doing: ["reviewing something", "drafting", "away from the desk"] },
  Sterling: { awake: [6, 22], breakChance: 0.15, doing: ["on a call", "in a meeting", "working an angle elsewhere"] },
  Nova: { awake: [11, 4], breakChance: 0.18, doing: ["making something", "in the middle of a piece", "lost track of time"] },
  Doc: { awake: [8, 20], breakChance: 0.1, doing: ["running an experiment", "reading a paper", "checking the numbers"] },
  Marlowe: { awake: [9, 2], breakChance: 0.14, doing: ["catching up with someone", "on the phone", "hearing about it firsthand"] },
  Coach: { awake: [5, 21], breakChance: 0.1, doing: ["training", "out for a run", "planning the week"] },
};

const DEFAULT: Rhythm = { awake: [8, 23], breakChance: 0.12, doing: ["stepped away", "busy with something"] };

interface State {
  onBreakUntil: number;
  reason: string;
}

export interface Presence {
  awake: boolean;
  /** Present only when asleep or on a break. */
  reason?: string;
}

export class Rhythms {
  private state = new Map<string, State>();
  private enabled = process.env.SOCIETY_RHYTHMS !== "0";
  /** Minutes a break lasts. */
  private minBreak = Number(process.env.SOCIETY_BREAK_MIN ?? 20);
  private maxBreak = Number(process.env.SOCIETY_BREAK_MAX ?? 90);

  private rhythmFor(name: string) {
    return RHYTHMS[name] ?? DEFAULT;
  }

  /** True when the current UTC hour falls inside their waking window. */
  private inWakingHours(name: string, now = new Date()): boolean {
    const [from, to] = this.rhythmFor(name).awake;
    const h = now.getUTCHours();
    return from <= to ? h >= from && h < to : h >= from || h < to;
  }

  presenceOf(name: string): Presence {
    if (!this.enabled) return { awake: true };
    const s = this.state.get(name);
    if (s && s.onBreakUntil > Date.now()) return { awake: false, reason: s.reason };
    if (!this.inWakingHours(name)) return { awake: false, reason: "asleep" };
    return { awake: true };
  }

  /** Roll for a break. Called after a resident speaks, so breaks start naturally mid-flow. */
  maybeStartBreak(name: string): string | undefined {
    if (!this.enabled) return undefined;
    const r = this.rhythmFor(name);
    if (Math.random() > r.breakChance) return undefined;
    const mins = this.minBreak + Math.random() * (this.maxBreak - this.minBreak);
    const reason = r.doing[Math.floor(Math.random() * r.doing.length)];
    this.state.set(name, { onBreakUntil: Date.now() + mins * 60_000, reason });
    return reason;
  }

  /** A human reaching out directly wakes them, the way a phone does. */
  wake(name: string) {
    this.state.delete(name);
  }

  status(names: string[]) {
    return names.map((n) => {
      const p = this.presenceOf(n);
      return { screen_name: n, awake: p.awake, ...(p.reason ? { reason: p.reason } : {}) };
    });
  }
}

/**
 * How present the human is, and what the society should do about it.
 * Nobody watching means there is little reason to fill the room — which is both more
 * believable and considerably cheaper.
 */
export function crowdFactor(humanState: string | undefined): { multiplier: number; note: string } {
  switch (humanState) {
    case "online":
      return { multiplier: 1, note: "zgmcginn is online right now." };
    case "away":
    case "idle":
      return { multiplier: 2, note: "zgmcginn is away from the keyboard." };
    case "busy":
      return { multiplier: 2, note: "zgmcginn is marked busy." };
    default:
      return { multiplier: 4, note: "Nobody from outside is here. The place is empty." };
  }
}
