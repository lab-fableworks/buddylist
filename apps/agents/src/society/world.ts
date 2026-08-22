/**
 * Shared world state: money, opinions, proposals.
 *
 * The chat log *is* the ledger. Every economic or civic act is posted as an `x-` payload in
 * the relevant room, so the state is durable, auditable, and visible to a human scrolling
 * back — no side database. On boot we replay those rooms to rebuild balances in memory.
 */
import type { BuddyList, Message } from "@buddylist/sdk";

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
}
export interface Opinion {
  score: number; // -5 hostile .. +5 devoted
  note: string;
}

export class World {
  balances = new Map<string, number>();
  /** who -> about -> opinion */
  opinions = new Map<string, Map<string, Opinion>>();
  proposals = new Map<string, Proposal>();

  constructor(starting: Array<{ screen_name: string; wealth: number }>) {
    for (const c of starting) this.balances.set(c.screen_name, c.wealth);
  }

  balance(who: string) {
    return this.balances.get(who) ?? 0;
  }

  /** Returns an error string when the payer cannot cover it, otherwise undefined. */
  applyTransfer(t: Transfer): string | undefined {
    const from = this.balance(t.from);
    if (t.amount <= 0) return "amount must be positive";
    if (from < t.amount) return `insufficient funds: you have ${from} bits, tried to send ${t.amount}`;
    this.balances.set(t.from, from - t.amount);
    this.balances.set(t.to, this.balance(t.to) + t.amount);
    return undefined;
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
    const lines: string[] = [`Your balance: ${this.balance(who)} bits.`];
    const mine = this.opinions.get(who);
    if (mine?.size) {
      const notes = [...mine.entries()]
        .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))
        .slice(0, 5)
        .map(([about, o]) => `${about}: ${o.score > 0 ? "+" : ""}${o.score} (${o.note})`);
      lines.push(`How you feel about people — ${notes.join("; ")}`);
    }
    const rich = everyone
      .map((n) => `${n} ${this.balance(n)}`)
      .sort((a, b) => Number(b.split(" ")[1]) - Number(a.split(" ")[1]))
      .slice(0, 3);
    lines.push(`Wealthiest right now: ${rich.join(", ")}.`);
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
  proposal: "x-civic.proposal",
  vote: "x-civic.vote",
  opinion: "x-social.opinion",
  resolution: "x-civic.resolution",
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
        case LEDGER_TYPES.proposal:
          world.addProposal({
            id: String(p.id),
            author: m.sender,
            title: String(p.title),
            detail: String(p.detail ?? ""),
            software: !!p.software,
            votes: {},
            status: "open",
          });
          break;
        case LEDGER_TYPES.vote:
          world.vote(String(p.id), m.sender, p.choice === "against" ? "against" : "for", electorate);
          break;
        case LEDGER_TYPES.opinion:
          world.setOpinion(m.sender, String(p.about), { score: Number(p.score), note: String(p.note ?? "") });
          break;
      }
    }
    if (page.length < 200) break;
  }
}
