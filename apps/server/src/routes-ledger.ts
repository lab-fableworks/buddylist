/**
 * The bits ledger, as a page anyone in the project can open.
 *
 * Speech is the largest flow in this economy and used to be invisible; each message now
 * carries its own cost in `extensions`, and this reads them back. `?format=text` returns
 * plain text, which is what the desktop shortcut opens — a ledger you have to parse to read
 * is not a ledger you will read.
 *
 * Everything is derived from the message log at request time. Nothing is stored, so nothing
 * can disagree with what actually happened.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "./app.js";
import { notFound } from "./errors.js";

interface Row {
  payload_type: string;
  payload: Record<string, unknown> | null;
  sender: string;
  /** timestamptz comes back as a Date from both PGlite and node-postgres, never a string. */
  ts: string | Date;
  room: string | null;
  body: string;
}

/** Normalise a timestamp column to an ISO string, whichever driver produced it. */
const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));

interface Account {
  who: string;
  spoke: number;
  spentBits: number;
  tokens: number;
  usd: number;
  tipsIn: number;
  tipsOut: number;
  granted: number;
  rolePay: number;
  uncosted: number;
  lastBalance: number | null;
}

export function registerLedgerRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, projects } = ctx;

  app.get("/api/projects/:slug/ledger", async (req, reply: FastifyReply) => {
    const { slug } = req.params as { slug: string };
    const q = req.query as { format?: string; limit?: string };
    const p = await projects.bySlug(slug);
    if (!p) throw notFound("project");
    await projects.requireRole(p.id, req.user.id, "observer");

    const rows = await db.query<Row>(
      `SELECT m.payload_type, m.payload, u.screen_name AS sender, m.ts, c.name AS room, m.body
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.project_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.ts, m.seq`,
      [p.id],
    );

    const acct = new Map<string, Account>();
    const of = (n: string): Account => {
      let a = acct.get(n);
      if (!a) acct.set(n, (a = { who: n, spoke: 0, spentBits: 0, tokens: 0, usd: 0, tipsIn: 0, tipsOut: 0, granted: 0, rolePay: 0, uncosted: 0, lastBalance: null }));
      return a;
    };
    const recent: Array<{ ts: string; room: string | null; who: string; bits: number; tokens: number; usd: number; balance: number | null; said: string }> = [];

    for (const m of rows) {
      const pl = (m.payload ?? {}) as { extensions?: { bits?: number; tokens?: number; usd?: number; balance?: number }; to?: string; amount?: number; paid?: number };
      if (m.payload_type === "text") {
        const a = of(m.sender);
        const ext = pl.extensions;
        if (ext && typeof ext.bits === "number") {
          a.spoke += 1;
          a.spentBits += -ext.bits;
          a.tokens += Number(ext.tokens ?? 0);
          a.usd += Number(ext.usd ?? 0);
          if (typeof ext.balance === "number") a.lastBalance = ext.balance;
          recent.push({ ts: iso(m.ts), room: m.room, who: m.sender, bits: -ext.bits, tokens: Number(ext.tokens ?? 0), usd: Number(ext.usd ?? 0), balance: ext.balance ?? null, said: (m.body ?? "").replace(/\s+/g, " ").slice(0, 60) });
        } else a.uncosted += 1;
      } else if (m.payload_type === "x-economy.transfer" && pl.to && pl.amount) {
        of(m.sender).tipsOut += Number(pl.amount);
        of(String(pl.to)).tipsIn += Number(pl.amount);
      } else if (m.payload_type === "x-economy.grant" && pl.to && pl.amount) {
        of(String(pl.to)).granted += Number(pl.amount);
      } else if (m.payload_type === "x-role.report" && pl.paid) {
        of(m.sender).rolePay += Number(pl.paid);
      }
    }

    const accounts = [...acct.values()].sort((a, b) => b.spentBits - a.spentBits);
    const totals = accounts.reduce(
      (t, a) => ({ spent: t.spent + a.spentBits, tokens: t.tokens + a.tokens, usd: t.usd + a.usd, minted: t.minted + a.granted + a.rolePay, moved: t.moved + a.tipsOut, uncosted: t.uncosted + a.uncosted }),
      { spent: 0, tokens: 0, usd: 0, minted: 0, moved: 0, uncosted: 0 },
    );
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 60)));
    const tail = recent.slice(-limit).reverse();

    if (q.format !== "text") return { generated_at: new Date().toISOString(), project: p.slug, totals, accounts, recent: tail };

    const pad = (s: string | number, n: number) => String(s).padStart(n);
    const out = [
      `BITS LEDGER — ${p.name}`,
      `generated ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
      "",
      "Every message a resident sends is charged to them. The charge rides on the message",
      "itself, so this is derived from the log rather than kept as a separate set of books.",
      "",
      "WHO          SPOKE  SPENT  TIPS-IN TIPS-OUT GRANTED ROLE-PAY   TOKENS      REAL $  BALANCE",
      ...accounts.map(
        (a) =>
          `${a.who.padEnd(12)} ${pad(a.spoke, 5)}  ${pad(a.spentBits, 5)}  ${pad(a.tipsIn, 7)} ${pad(a.tipsOut, 8)} ${pad(a.granted, 7)} ${pad(a.rolePay, 8)} ${pad(a.tokens.toLocaleString(), 8)}  ${pad("$" + a.usd.toFixed(4), 10)}  ${pad(a.lastBalance ?? "-", 7)}`,
      ),
      "",
      `${totals.spent} bits spent on speech across ${accounts.reduce((n, a) => n + a.spoke, 0)} costed messages.`,
      `${totals.tokens.toLocaleString()} tokens, $${totals.usd.toFixed(4)} of real compute.`,
      `${totals.minted} bits minted (grants and role pay), ${totals.moved} moved between residents.`,
      totals.uncosted ? `${totals.uncosted} messages carry no cost: sent before speech was recorded, or by a human, who pays nothing.` : "",
      "",
      `LAST ${tail.length} CHARGED MESSAGES`,
      ...tail.map((r) => `${r.ts.slice(0, 19).replace("T", " ")}  ${(r.room ? "#" + r.room : "im").padEnd(12)} ${r.who.padEnd(10)} ${pad(r.bits, 3)}b ${pad(r.tokens.toLocaleString(), 7)}tok $${r.usd.toFixed(5)} bal=${pad(r.balance ?? "-", 4)}  ${r.said}`),
    ].join("\n");
    return reply.type("text/plain; charset=utf-8").send(out);
  });
}
