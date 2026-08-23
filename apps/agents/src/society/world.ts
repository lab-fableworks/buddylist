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

export const RELATION_KINDS = ["ally", "rival", "mentor", "apprentice", "partner"] as const;
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
}

/**
 * Bits are backed by real compute. A turn's cost in bits is derived from the dollars that turn
 * actually spent on the API, so the in-world economy is a faithful shadow of the real one —
 * scarcity here is not invented, it is the same scarcity the operator is paying for.
 */
export const BITS_PER_USD = Number(process.env.SOCIETY_BITS_PER_USD ?? 500);
export const speechCost = (usd: number) => Math.max(1, Math.round(usd * BITS_PER_USD));

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
    if (held) return held.holder === who ? `you already hold ${name}` : `${name} is held by ${held.holder}`;
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
  fileReport(name: string, who: string, now = Date.now()): { ok: boolean; paid: number; err?: string } {
    const def = this.roleDef(name);
    const held = this.roles.get(name);
    if (!def || !held || held.holder !== who) return { ok: false, paid: 0, err: `${who} does not hold ${name}` };
    const gapMs = def.cadenceHours * 3600_000 * 0.9;
    const paid = held.lastPaidAt === undefined || now - held.lastPaidAt >= gapMs ? def.pay : 0;
    held.lastReportAt = now;
    held.reports += 1;
    if (paid) {
      held.lastPaidAt = now;
      this.credit(who, paid);
    }
    return { ok: true, paid };
  }
  /** Replay-side twin of fileReport: the timestamp and count, no payout. */
  recordReport(name: string, who: string, at: number) {
    const held = this.roles.get(name);
    if (!held || held.holder !== who) return;
    held.lastReportAt = at;
    held.lastPaidAt = at;
    held.reports += 1;
  }
  /** Periodic roles whose report is overdue. Triggered roles are the director's business. */
  dueRoles(now = Date.now()): Array<{ name: string; holder: string; overdueHours: number }> {
    const out: Array<{ name: string; holder: string; overdueHours: number }> = [];
    for (const [name, state] of this.roles) {
      const def = this.roleDef(name);
      if (!def || def.trigger) continue;
      const last = state.lastReportAt ?? state.since;
      const hours = (now - last) / 3600_000;
      if (hours >= def.cadenceHours) out.push({ name, holder: state.holder, overdueHours: Math.round(hours - def.cadenceHours) });
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
      `Speaking costs bits — roughly ${Math.round(0.0035 * BITS_PER_USD)} per message, more when you talk at length. If you cannot pay, you cannot speak at all until you earn some.`,
      `You earn bits by: answering the human (+${EARNINGS.servedHuman}), getting a proposal passed (+${EARNINGS.proposalPassed}), voting (+${EARNINGS.votedq}, once per proposal — repeats pay nothing), and being tipped by others.`,
      bal < 15 ? "You are nearly broke. Being useful is now urgent — say something worth paying for, or ask someone to tip you." : "",
    ].filter(Boolean);
    const mine = this.opinions.get(who);
    if (mine?.size) {
      const notes = [...mine.entries()]
        .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))
        .slice(0, 5)
        .map(([about, o]) => `${about}: ${o.score > 0 ? "+" : ""}${o.score} (${o.note})`);
      lines.push(`How you feel about people — ${notes.join("; ")}`);
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
      lines.push(`You are the ${myRole.name}. Duty: ${myRole.def.duty} Pays ${myRole.def.pay} bits per report. Last report: ${ago}${due ? " — OVERDUE. You will be given the floor for it." : ""}.`);
    } else {
      const vacant = this.vacantRoles();
      if (vacant.length) lines.push(`Vacant roles you could take with the take_role tool: ${vacant.map((r) => `${r.name} (${r.pay}b per report — ${r.duty.split(".")[0]}.)`).join(" | ")}`);
    }
    const held = [...this.roles.entries()].filter(([, s]) => s.holder !== who);
    if (held.length) lines.push(`Who holds what: ${held.map(([n, s]) => `${s.holder} is ${n}`).join(", ")}.`);
    const rich = everyone
      .map((n) => `${n} ${this.balance(n)}`)
      .sort((a, b) => Number(b.split(" ")[1]) - Number(a.split(" ")[1]))
      .slice(0, 3);
    lines.push(`Wealthiest right now: ${rich.join(", ")}.`);
    const done = [...this.shipped];
    if (done.length) lines.push(`Already built and shipped (do not ask for these again): ${done.join(", ")}.`);
    const open = this.openProposals();
    if (open.length) {
      lines.push(
        `Open proposals you may vote on: ${open
          .map((p) => `[${p.id}] "${p.title}" by ${p.author} (${Object.keys(p.votes).length} votes so far${p.votes[who] ? ", you voted " + p.votes[who] : ", you have NOT voted"})`)
          .join(" | ")}`,
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
        case LEDGER_TYPES.proposal:
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
          break;
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
        case LEDGER_TYPES.vote:
          world.vote(String(p.id), m.sender, p.choice === "against" ? "against" : "for", electorate);
          break;
        case LEDGER_TYPES.opinion:
          world.setOpinion(m.sender, String(p.about), { score: Number(p.score), note: String(p.note ?? "") });
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
