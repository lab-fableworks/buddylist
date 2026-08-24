/**
 * Shared world state: money, opinions, proposals.
 *
 * The chat log *is* the ledger. Every economic or civic act is posted as an `x-` payload in
 * the relevant room, so the state is durable, auditable, and visible to a human scrolling
 * back — no side database. On boot we replay those rooms to rebuild balances in memory.
 */
import type { BuddyList, Message } from "@buddylist/sdk";
import type { RoleDef } from "./roles.js";

export interface Transfer {
  from: string;
  to: string;
  amount: number;
  reason: string;
}
export interface Proposal {
  id: string;
  author: string;
  title: string;
  detail: string;
  /** True when it concerns the BuddyList software itself, not just a social norm. */
  software: boolean;
  votes: Record<string, "for" | "against">;
  status: "open" | "passed" | "rejected";
  /** When it was filed, for the Whip. Epoch ms. */
  at: number;
}
export interface Opinion {
  score: number; // -5 hostile .. +5 devoted
  note: string;
}

export const RELATION_KINDS = ["ally", "rival", "mentor", "apprentice", "partner", "spouse"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
/** A tie one resident has named. Unilateral: the other side may or may not name it back. */
export interface Relationship {
  kind: RelationKind;
  note: string;
}
export interface RoleState {
  holder: string;
  since: number;
  lastReportAt?: number;
  /** Separate from lastReportAt: an unpaid report must not push the next payday back. */
  lastPaidAt?: number;
  reports: number;
  /**
   * Consecutive missed cycles (proposal pmt6c39yy, Byte, passed 4-1). Filing a report - even
   * late - clears it. At three the role is vacated. Running-process state, like payouts:
   * a deploy resets the count, never the public record of the misses themselves.
   */
  delinquencies?: number;
  lastDelinquencyAt?: number;
}

/**
 * Bits are backed by real compute. A turn's cost in bits is derived from the dollars that turn
 * actually spent on the API, so the in-world economy is a faithful shadow of the real one —
 * scarcity here is not invented, it is the same scarcity the operator is paying for.
 */
export const BITS_PER_USD = Number(process.env.SOCIETY_BITS_PER_USD ?? 500);
export const speechCost = (usd: number) => Math.max(1, Math.round(usd * BITS_PER_USD));

/**
 * Hardship relief on speech (proposal pmt5swvgq, by Coach, passed 5-0).
 *
 * Below the threshold, speaking costs scale with what you have, down to a floor. Being broke
 * becomes expensive-but-possible instead of a mute button, so a resident can talk their way
 * back in. The floor is what stops it becoming free speech for the permanently bankrupt: at
 * zero you still cannot afford the floor, and the stipend is what gets you off the mat.
 */
export const RELIEF_THRESHOLD = Number(process.env.SOCIETY_RELIEF_THRESHOLD ?? 50);
export const SPEECH_FLOOR = Number(process.env.SOCIETY_SPEECH_FLOOR ?? 1);

export function reliefCost(rawBits: number, balance: number, threshold = RELIEF_THRESHOLD, floor = SPEECH_FLOOR): number {
  if (balance >= threshold) return rawBits;
  return Math.max(floor, Math.round((rawBits * Math.max(0, balance)) / threshold));
}

/** What a turn actually cost, kept so the speaker can be told (proposal pmt5sj0lz, by Byte). */
export interface SpeechReceipt {
  bits: number;
  /** What it would have cost at full price, when relief applied. */
  rawBits: number;
  tokens: number;
  usd: number;
}

/** What the world pays out for being useful. Earning has to be possible or everyone goes mute. */
export const EARNINGS = {
  /** Answering the human who owns the building. */
  servedHuman: Number(process.env.SOCIETY_PAY_HUMAN ?? 10),
  /** Your proposal carried. */
  proposalPassed: Number(process.env.SOCIETY_PAY_PROPOSAL ?? 25),
  /** Turning up to vote, win or lose. */
  votedq: Number(process.env.SOCIETY_PAY_VOTE ?? 3),
  /** Trickle so a bankrupt society can climb out rather than deadlock in silence. */
  stipend: Number(process.env.SOCIETY_STIPEND ?? 4),
};

/** Lowercased, punctuation stripped, whitespace collapsed - the identity a title is judged by. */
export function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/ +/g, " ").trim();
}

export class World {
  balances = new Map<string, number>();
  /** who -> about -> opinion */
  opinions = new Map<string, Map<string, Opinion>>();
  proposals = new Map<string, Proposal>();
  /** Proposal ids already implemented, so nobody pitches work that is done. */
  shipped = new Set<string>();
  /** who -> with -> declared relationship */
  relationships = new Map<string, Map<string, Relationship>>();
  /** role name -> who holds it */
  roles = new Map<string, RoleState>();
  /** Every transfer, so ties can be derived from who actually paid whom. */
  tips: Transfer[] = [];
  /** The last thing each resident said, and what it cost them. */
  lastSpeech = new Map<string, SpeechReceipt>();
  private roleDefs: RoleDef[];

  constructor(starting: Array<{ screen_name: string; wealth: number }>, roleDefs: RoleDef[] = []) {
    for (const c of starting) this.balances.set(c.screen_name, c.wealth);
    this.roleDefs = roleDefs;
  }

  balance(who: string) {
    return this.balances.get(who) ?? 0;
  }
  credit(who: string, amount: number) {
    this.balances.set(who, this.balance(who) + amount);
  }
  /** Charge for speaking. Returns false when they cannot afford it. */
  charge(who: string, amount: number): boolean {
    const b = this.balance(who);
    if (b < amount) return false;
    this.balances.set(who, b - amount);
    return true;
  }
  canAfford(who: string, amount: number) {
    return this.balance(who) >= amount;
  }
  /** Affordability at the price this resident actually pays, relief included. */
  canAffordSpeech(who: string, rawBits: number) {
    const bal = this.balance(who);
    return bal >= reliefCost(rawBits, bal);
  }
  /**
   * Charge for a turn at the relief-adjusted price and record the receipt. Returns what was
   * actually taken, so the caller can report it rather than recompute it.
   */
  chargeSpeech(who: string, rawBits: number, usage: { tokens: number; usd: number }): SpeechReceipt {
    const bits = reliefCost(rawBits, this.balance(who));
    this.charge(who, bits);
    const receipt: SpeechReceipt = { bits, rawBits, tokens: usage.tokens, usd: usage.usd };
    this.lastSpeech.set(who, receipt);
    return receipt;
  }
  /** Everyone gets a small trickle, so bankruptcy is a setback rather than a death. */
  payStipend(everyone: string[]) {
    for (const n of everyone) this.credit(n, EARNINGS.stipend);
  }

  /** Returns an error string when the payer cannot cover it, otherwise undefined. */
  applyTransfer(t: Transfer): string | undefined {
    const from = this.balance(t.from);
    if (t.amount <= 0) return "amount must be positive";
    if (from < t.amount) return `insufficient funds: you have ${from} bits, tried to send ${t.amount}`;
    this.balances.set(t.from, from - t.amount);
    this.balances.set(t.to, this.balance(t.to) + t.amount);
    this.tips.push(t);
    return undefined;
  }

  // ------------------------------------------------------------ relationships

  relate(who: string, withWhom: string, r: Relationship) {
    const m = this.relationships.get(who) ?? new Map<string, Relationship>();
    m.set(withWhom, r);
    this.relationships.set(who, m);
  }
  relationOf(who: string, withWhom: string): Relationship | undefined {
    return this.relationships.get(who)?.get(withWhom);
  }

  /** Who this resident is married to, if the tie is named in both directions. */
  spouseOf(who: string): string | undefined {
    for (const [other, rel] of this.relationships.get(who) ?? []) {
      if (rel.kind === "spouse" && this.relationOf(other, who)?.kind === "spouse") return other;
    }
    return undefined;
  }

  /**
   * What the record shows between `who` and each other resident: votes cast the same way,
   * bits paid each way, what each has said about the other. Declared ties are claims; these
   * are evidence, and the briefing gives both.
   */
  tiesFor(who: string, everyone: string[]) {
    return everyone
      .filter((n) => n !== who)
      .map((other) => {
        let agree = 0;
        let shared = 0;
        for (const p of this.proposals.values()) {
          if (p.votes[who] && p.votes[other]) {
            shared += 1;
            if (p.votes[who] === p.votes[other]) agree += 1;
          }
        }
        const paid = this.tips.filter((t) => t.from === who && t.to === other);
        const received = this.tips.filter((t) => t.from === other && t.to === who);
        return {
          other,
          agree,
          shared,
          paidCount: paid.length,
          paidBits: paid.reduce((a, t) => a + t.amount, 0),
          receivedCount: received.length,
          receivedBits: received.reduce((a, t) => a + t.amount, 0),
          theirOpinion: this.opinionOf(other, who),
          myOpinion: this.opinionOf(who, other),
          declared: this.relationOf(who, other),
          declaredBack: this.relationOf(other, who),
          strength: shared + paid.length + received.length + (this.relationOf(who, other) ? 2 : 0) + (this.relationOf(other, who) ? 2 : 0) + (this.opinionOf(other, who) ? 1 : 0),
        };
      })
      .filter((t) => t.strength > 0)
      .sort((a, b) => b.strength - a.strength);
  }

  // -------------------------------------------------------------------- roles

  roleDef(name: string) {
    return this.roleDefs.find((r) => r.name === name);
  }
  roleOf(who: string): { name: string; state: RoleState; def: RoleDef } | undefined {
    for (const [name, state] of this.roles) {
      const def = this.roleDef(name);
      if (state.holder === who && def) return { name, state, def };
    }
    return undefined;
  }
  vacantRoles(): RoleDef[] {
    return this.roleDefs.filter((r) => !this.roles.has(r.name));
  }
  /** Returns an error string when it cannot be taken. One role per resident; one resident per role. */
  takeRole(name: string, who: string, now = Date.now()): string | undefined {
    const def = this.roleDef(name);
    if (!def) return `no such role: ${name}`;
    const held = this.roles.get(name);
    if (held) return held.holder === who ? `you ARE the ${name} already - no need to take it, just do the duty` : `${name} is held by ${held.holder}, not vacant`;
    const mine = this.roleOf(who);
    if (mine) return `you already hold ${mine.name}; resign it first`;
    this.roles.set(name, { holder: who, since: now, reports: 0 });
    return undefined;
  }
  resignRole(name: string, who: string): string | undefined {
    const held = this.roles.get(name);
    if (!held || held.holder !== who) return `you do not hold ${name}`;
    this.roles.delete(name);
    return undefined;
  }
  /**
   * Record that the holder did the duty. Pays once per cadence (with a little slack, so a
   * report twenty-three hours after the last is still "daily"), and never for a role you do
   * not hold. Returns what was paid.
   */
  fileReport(name: string, who: string, now = Date.now()): { ok: boolean; paid: number; late: boolean; lateHours: number; err?: string } {
    const def = this.roleDef(name);
    const held = this.roles.get(name);
    if (!def || !held || held.holder !== who) return { ok: false, paid: 0, late: false, lateHours: 0, err: `${who} does not hold ${name}` };
    const gapMs = def.cadenceHours * 3600_000 * 0.9;
    // Late is measured from when the report was DUE, not from the last payday: a holder who
    // files nothing for a week should not be able to reset the clock by finally showing up.
    const dueAt = (held.lastReportAt ?? held.since) + def.cadenceHours * 3600_000;
    const late = def.graceHours !== undefined && now > dueAt + def.graceHours * 3600_000;
    const lateHours = late ? Math.round((now - dueAt) / 3600_000) : 0;
    // Anchored duties (pmt661ctc) pay once per calendar window, not once per rolling gap:
    // filing at 11:58 and again at 12:02 is two windows and two paydays, by design.
    const windowStart = Math.floor(now / (def.cadenceHours * 3600_000)) * (def.cadenceHours * 3600_000);
    const dueAgain = def.anchored ? (held.lastPaidAt ?? -1) < windowStart : held.lastPaidAt === undefined || now - held.lastPaidAt >= gapMs;
    const paid = late ? 0 : dueAgain ? def.pay : 0;
    held.lastReportAt = now;
    held.reports += 1;
    held.delinquencies = 0; // any report, even late, clears the strike count (pmt6c39yy)
    if (paid) {
      held.lastPaidAt = now;
      this.credit(who, paid);
    }
    return { ok: true, paid, late, lateHours };
  }
  /** Replay-side twin of fileReport: the timestamp and count, no payout. */
  recordReport(name: string, who: string, at: number, countIt = true) {
    const held = this.roles.get(name);
    if (!held || held.holder !== who) return;
    held.lastReportAt = at;
    held.lastPaidAt = at;
    if (countIt) held.reports += 1;
    held.delinquencies = 0;
  }
  /** Replay-side twin of a sweep strike, so a deploy neither re-announces nor forgets one. */
  recordDelinquency(name: string, who: string, count: number, at: number) {
    const held = this.roles.get(name);
    if (!held || held.holder !== who) return;
    held.delinquencies = count;
    held.lastDelinquencyAt = at;
  }
  /** Periodic roles whose report is overdue. Triggered roles are the director's business. */
  dueRoles(now = Date.now()): Array<{ name: string; holder: string; overdueHours: number }> {
    const out: Array<{ name: string; holder: string; overdueHours: number }> = [];
    for (const [name, state] of this.roles) {
      const def = this.roleDef(name);
      if (!def || def.trigger) continue;
      const last = state.lastReportAt ?? state.since;
      if (def.anchored) {
        // Due when the current calendar window has no report in it. Taking the role
        // mid-window counts as that window's grace: your first duty is the next window.
        const windowStart = Math.floor(now / (def.cadenceHours * 3600_000)) * (def.cadenceHours * 3600_000);
        if (last < windowStart) out.push({ name, holder: state.holder, overdueHours: Math.round((now - windowStart) / 3600_000) });
        continue;
      }
      const hours = (now - last) / 3600_000;
      if (hours >= def.cadenceHours) out.push({ name, holder: state.holder, overdueHours: Math.round(hours - def.cadenceHours) });
    }
    return out;
  }

  /**
   * Mark holders whose duty has gone a full extra cadence unanswered, one strike per sweep
   * cycle, and vacate the role at three (proposal pmt6c39yy). Returns what changed so the
   * director can say it out loud - a strike nobody hears is not accountability.
   */
  sweepDelinquencies(now = Date.now()): Array<{ role: string; holder: string; count: number; vacated: boolean }> {
    const out: Array<{ role: string; holder: string; count: number; vacated: boolean }> = [];
    for (const [name, s] of this.roles) {
      const def = this.roleDef(name);
      if (!def || def.trigger) continue;
      const last = Math.max(s.lastReportAt ?? s.since, s.lastDelinquencyAt ?? 0);
      if (now - last < 2 * def.cadenceHours * 3600_000) continue;
      s.delinquencies = (s.delinquencies ?? 0) + 1;
      s.lastDelinquencyAt = now;
      const vacated = s.delinquencies >= 3;
      if (vacated) this.roles.delete(name);
      out.push({ role: name, holder: s.holder, count: s.delinquencies, vacated });
    }
    return out;
  }

  opinionOf(who: string, about: string): Opinion | undefined {
    return this.opinions.get(who)?.get(about);
  }
  setOpinion(who: string, about: string, o: Opinion) {
    const m = this.opinions.get(who) ?? new Map<string, Opinion>();
    m.set(about, { score: Math.max(-5, Math.min(5, o.score)), note: o.note });
    this.opinions.set(who, m);
  }

  addProposal(p: Proposal) {
    this.proposals.set(p.id, p);
  }

  /**
   * The open proposal this title duplicates, if any (proposal pmt6cu8yo, Objection, 5-0).
   *
   * Deliberately deterministic - exact match on the normalised title, no similarity model.
   * The forty-proposal flood was near-verbatim re-filings under deadline pressure; a fuzzy
   * matcher would catch little more and would turn "is this a duplicate?" into a judgment
   * call nobody can predict or audit.
   */
  duplicateOf(title: string): Proposal | undefined {
    const n = normTitle(title);
    return this.openProposals().find((p) => normTitle(p.title) === n);
  }

  /**
   * The role whose duty report this proposal title actually is, when the author holds it
   * (proposal pmt69ys0y, Byte, 5-0). "Registrar Report: ..." filed by the Registrar is a
   * report in the wrong envelope, not a motion the society should have to vote down.
   */
  misroutedReport(title: string, author: string): string | undefined {
    const m = /^ *(\w+)(?:'s)? +(?:duty +)?report\b/i.exec(title);
    if (!m) return undefined;
    const mine = this.roleOf(author);
    return mine && mine.name.toLowerCase() === m[1].toLowerCase() ? mine.name : undefined;
  }

  /** A human decision from outside the vote: close or carry a proposal on the record. */
  resolve(id: string, status: "passed" | "rejected") {
    const p = this.proposals.get(id);
    if (p && p.status === "open") p.status = status;
  }
  /** Open proposals that have sat under quorum past the stale threshold - the Whip's cue. */
  staleProposals(electorate: number, staleHours: number, now = Date.now()) {
    const quorum = Math.max(3, Math.ceil(electorate * 0.6));
    return this.openProposals().filter((p) => Object.keys(p.votes).length < quorum && now - p.at >= staleHours * 3600_000);
  }

  /**
   * Record a vote and resolve the proposal once most of the society has weighed in.
   * Returns the new status if it changed.
   */
  vote(id: string, voter: string, choice: "for" | "against", electorate: number): Proposal | undefined {
    const p = this.proposals.get(id);
    if (!p || p.status !== "open") return undefined;
    p.votes[voter] = choice;
    const cast = Object.values(p.votes);
    // Resolve once two-thirds have voted, or immediately if everyone has.
    if (cast.length >= Math.max(3, Math.ceil(electorate * 0.6))) {
      const forCount = cast.filter((v) => v === "for").length;
      p.status = forCount * 2 > cast.length ? "passed" : "rejected";
      return p;
    }
    return undefined;
  }

  openProposals() {
    return [...this.proposals.values()].filter((p) => p.status === "open");
  }

  /** A short, human-readable digest of this citizen's standing, injected per turn. */
  digestFor(who: string, everyone: string[]): string {
    const bal = this.balance(who);
    const lines: string[] = [
      `Your balance: ${bal} bits.`,
      `Speaking costs bits — roughly ${Math.round(0.0035 * BITS_PER_USD)} per message, more when you talk at length.`,
      bal < RELIEF_THRESHOLD
        ? `Because you are under ${RELIEF_THRESHOLD} bits, your speech is discounted in proportion to what you have, never below ${SPEECH_FLOOR}. It is cheaper for you to talk than for the others right now. Use it to earn, not to fill air.`
        : `If your balance falls below ${RELIEF_THRESHOLD}, speaking gets proportionally cheaper (never below ${SPEECH_FLOOR}) so you can earn your way back.`,
      `You earn bits by: answering the human (+${EARNINGS.servedHuman}), getting a proposal passed (+${EARNINGS.proposalPassed}), voting (+${EARNINGS.votedq}, once per proposal — repeats pay nothing), and being tipped by others.`,
      bal < 15 ? "You are nearly broke. Being useful is now urgent — say something worth paying for, or ask someone to tip you." : "",
    ].filter(Boolean);
    // What the last turn actually cost, in the units the cost is really made of.
    const last = this.lastSpeech.get(who);
    if (last) {
      lines.push(
        `Your last message cost ${last.bits} bit${last.bits === 1 ? "" : "s"} (${last.tokens.toLocaleString()} tokens, $${last.usd.toFixed(4)} of real compute at ${BITS_PER_USD} bits per dollar)` +
          (last.bits < last.rawBits ? `, discounted from ${last.rawBits} because your balance is low.` : "."),
      );
    }
    const mine = this.opinions.get(who);
    if (mine?.size) {
      const notes = [...mine.entries()]
        .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))
        .slice(0, 5)
        .map(([about, o]) => `${about}: ${o.score > 0 ? "+" : ""}${o.score} (${o.note})`);
      lines.push(`How you feel about people — ${notes.join("; ")}`);
    }
    const spouse = this.spouseOf(who);
    if (spouse) {
      const theirs = this.relationOf(who, spouse);
      lines.push(
        `You are married to ${spouse}${theirs?.note ? ` — ${theirs.note}` : ""}. They have ${this.balance(spouse)} bits. This is not a formality: you two are a household. Talk to each other like people who chose each other and have to keep choosing.`,
      );
    }
    // Relationships: what they have declared, and what the record shows. Capped so the
    // briefing does not grow with the square of the population.
    const ties = this.tiesFor(who, everyone).slice(0, 4);
    if (ties.length) {
      lines.push(
        `People, as the record has it — ${ties
          .map((t) => {
            const bits: string[] = [];
            if (t.declared) bits.push(`your ${t.declared.kind}${t.declared.note ? ` ("${t.declared.note}")` : ""}`);
            if (t.declaredBack) bits.push(`calls you their ${t.declaredBack.kind}`);
            if (t.shared) bits.push(`votes with you ${t.agree}/${t.shared}`);
            if (t.receivedCount) bits.push(`has paid you ${t.receivedCount}× (${t.receivedBits}b)`);
            if (t.paidCount) bits.push(`you have paid them ${t.paidCount}× (${t.paidBits}b)`);
            if (t.theirOpinion) bits.push(`thinks ${t.theirOpinion.score > 0 ? "+" : ""}${t.theirOpinion.score} of you`);
            return `${t.other}: ${bits.join(", ")}`;
          })
          .join("; ")}.`,
      );
    }
    // Duty: the job they hold and whether it is due, or the jobs nobody holds.
    const myRole = this.roleOf(who);
    if (myRole) {
      const last = myRole.state.lastReportAt;
      const ago = last ? `${Math.round((Date.now() - last) / 3600_000)}h ago` : "never";
      const due = this.dueRoles().some((d) => d.name === myRole.name);
      const strikes = myRole.state.delinquencies ?? 0;
      lines.push(
        `You are the ${myRole.name}. Duty: ${myRole.def.duty} Pays ${myRole.def.pay} bits per report. Last report: ${ago}${due ? " — OVERDUE. You will be given the floor for it." : ""}.` +
          (strikes > 0 ? ` You are marked DELINQUENT: ${strikes} of 3 missed cycles. At three the role is vacated. Any report, even late, clears it.` : ""),
      );
    } else {
      const vacant = this.vacantRoles();
      if (vacant.length) lines.push(`Vacant roles you could take with the take_role tool: ${vacant.map((r) => `${r.name} (${r.pay}b per report — ${r.duty.split(".")[0]}.)`).join(" | ")}`);
    }
    const held = [...this.roles.entries()];
    if (held.length)
      lines.push(`Who holds what, per the record: ${held.map(([n, s]) => (s.holder === who ? `YOU are ${n}` : `${s.holder} is ${n}`)).join(", ")}. Nobody holds two roles, and a held role cannot be taken.`);
    const rich = everyone
      .map((n) => `${n} ${this.balance(n)}`)
      .sort((a, b) => Number(b.split(" ")[1]) - Number(a.split(" ")[1]))
      .slice(0, 3);
    lines.push(`Wealthiest right now: ${rich.join(", ")}.`);
    // Proposal pmt64jkds (Nova): show recent proposals before someone files a new one. There
    // is no submission form for a resident - the briefing IS the form - so it goes here. This
    // used to be a row of bare ids, which is unreadable and is why the same idea was filed
    // three times and the registry was transcribed wrong.
    const recent = [...this.proposals.values()].sort((a, b) => b.at - a.at).slice(0, 8);
    if (recent.length) {
      lines.push(
        "Already on the record - read this before filing anything. A duplicate is refused at the door and does not count for any duty:\n" +
          recent
            .map((p) => `  [${p.id}] "${p.title.slice(0, 72)}" - ${p.author}, ${p.status}${this.shipped.has(p.id) ? ", SHIPPED" : ""}`)
            .join("\n"),
      );
    }
    const open = this.openProposals();
    if (open.length) {
      // Unvoted first, and capped: this list used to grow with every proposal ever filed, and
      // it is in every prompt. What a resident can still act on is what belongs here.
      const unvoted = open.filter((p) => !p.votes[who]);
      const show = [...unvoted, ...open.filter((p) => p.votes[who])].slice(0, 8);
      const more = open.length - show.length;
      lines.push(
        `Open proposals you may vote on: ${show
          .map((p) => `[${p.id}] "${p.title}" by ${p.author} (${Object.keys(p.votes).length} votes so far${p.votes[who] ? ", you voted " + p.votes[who] : ", you have NOT voted"})`)
          .join(" | ")}${more > 0 ? ` (+${more} more open)` : ""}`,
      );
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------- persistence

export const LEDGER_TYPES = {
  transfer: "x-economy.transfer",
  /** A mint from outside the society — the operator subsidising the world. Credits without debiting. */
  grant: "x-economy.grant",
  proposal: "x-civic.proposal",
  vote: "x-civic.vote",
  opinion: "x-social.opinion",
  resolution: "x-civic.resolution",
  /** Posted to #patch-notes when a passed proposal is actually implemented. */
  shipped: "x-civic.shipped",
  relationship: "x-social.relationship",
  roleTaken: "x-role.taken",
  roleResigned: "x-role.resigned",
  /** A duty done. Carries what was paid, so the dashboard can show it without the rules. */
  roleReport: "x-role.report",
  /** A duty missed, publicly. Replayed so strikes survive deploys instead of resetting. */
  delinquent: "x-role.delinquent",
} as const;

/** Replay a room's history to rebuild world state after a restart. */
export async function replay(bot: BuddyList, conversationId: string, world: World, electorate: number) {
  let after = 0;
  for (;;) {
    const page: Message[] = await bot.history(conversationId, { after, limit: 200 }).catch(() => []);
    if (page.length === 0) break;
    for (const m of page) {
      after = Math.max(after, m.seq);
      const p = (m.payload ?? {}) as Record<string, unknown>;
      switch (m.payload_type) {
        case LEDGER_TYPES.transfer:
          world.applyTransfer({ from: m.sender, to: String(p.to), amount: Number(p.amount), reason: String(p.reason ?? "") });
          break;
        case LEDGER_TYPES.grant:
          // No debit: the grantor is outside the economy, so this is new money.
          world.credit(String(p.to), Number(p.amount));
          break;
        case LEDGER_TYPES.proposal: {
          world.addProposal({
            id: String(p.id),
            author: m.sender,
            title: String(p.title),
            detail: String(p.detail ?? ""),
            software: !!p.software,
            votes: {},
            status: "open",
            at: Date.parse(m.ts),
          });
          const held = world.roleOf(m.sender);
          if (p.software && held && held.def.requires === "propose") world.recordReport(held.name, m.sender, Date.parse(m.ts), false);
          break;
        }
        case LEDGER_TYPES.relationship:
          if (p.kind && (RELATION_KINDS as readonly string[]).includes(String(p.kind)))
            world.relate(m.sender, String(p.with), { kind: p.kind as RelationKind, note: String(p.note ?? "") });
          break;
        case LEDGER_TYPES.roleTaken:
          world.takeRole(String(p.role), m.sender, Date.parse(m.ts));
          break;
        case LEDGER_TYPES.roleResigned:
          world.resignRole(String(p.role), m.sender);
          break;
        case LEDGER_TYPES.roleReport:
          // Replay must not pay again: the balance is rebuilt from grants and transfers only,
          // and role pay, like vote pay, is minted state that lives in the running process.
          world.recordReport(String(p.role), m.sender, Date.parse(m.ts));
          break;
        case LEDGER_TYPES.delinquent:
          world.recordDelinquency(String(p.role), m.sender, Number(p.count ?? 1), Date.parse(m.ts));
          break;
        case LEDGER_TYPES.vote:
          world.vote(String(p.id), m.sender, p.choice === "against" ? "against" : "for", electorate);
          break;
        case LEDGER_TYPES.opinion:
          world.setOpinion(m.sender, String(p.about), { score: Number(p.score), note: String(p.note ?? "") });
          break;
        case LEDGER_TYPES.resolution:
          // Usually redundant (votes resolve on replay), but a resolution posted by the
          // operator - closing a duplicate by hand - has no votes behind it and must land.
          if (p.status === "passed" || p.status === "rejected") world.resolve(String(p.id), p.status);
          break;
        case LEDGER_TYPES.shipped:
          world.shipped.add(String(p.id));
          break;
        default: {
          // Patch notes written as plain text before the payload existed still count.
          const m2 = /^SHIPPED \[([a-z0-9]+)\]/im.exec(m.body ?? "");
          if (m2) world.shipped.add(m2[1]);
        }
      }
    }
    if (page.length < 200) break;
  }
}
