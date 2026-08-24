/**
 * Aggregate statistics for the operator dashboard.
 *
 * Everything is computed in SQL rather than by shipping raw messages to the browser — the
 * message table is the largest thing in the system and the interesting numbers are all
 * aggregates. One endpoint, one round trip, so the dashboard stays simple.
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";
import { forbidden, notFound } from "./errors.js";

interface Row {
  [k: string]: unknown;
}

export function registerStatsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, projects, users } = ctx;

  /**
   * Everything the dashboard needs for one project. Requires membership, so this is not a
   * public leaderboard — you see only projects you are actually in.
   */
  app.get("/api/stats/:slug", async (req) => {
    const { slug } = req.params as { slug: string };
    const days = Math.min(90, Math.max(1, Number((req.query as { days?: string }).days ?? 14)));
    const p = await projects.bySlug(slug);
    if (!p) throw notFound("project");
    const role = await projects.roleOf(p.id, req.user.id);
    if (!role) throw forbidden("not a member of this project");

    const rooms = await db.query<{ id: string; name: string }>("SELECT id, name FROM conversations WHERE project_id=$1", [p.id]);
    const roomIds = rooms.map((r) => r.id);
    const empty = roomIds.length === 0;

    // ---- headline counts ----
    const totals = empty
      ? { messages: 0, senders: 0, first_at: null, last_at: null }
      : ((await db.one<Row>(
          `SELECT COUNT(*)::int AS messages, COUNT(DISTINCT sender_id)::int AS senders,
                  MIN(ts) AS first_at, MAX(ts) AS last_at
             FROM messages WHERE conversation_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [roomIds],
        )) as Row);

    // ---- engagement: messages per day, and per person ----
    const perDay = empty
      ? []
      : await db.query<Row>(
          `SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day, COUNT(*)::int AS messages
             FROM messages
            WHERE conversation_id = ANY($1::uuid[]) AND deleted_at IS NULL AND ts > now() - ($2 || ' days')::interval
            GROUP BY 1 ORDER BY 1`,
          [roomIds, String(days)],
        );

    const perPerson = empty
      ? []
      : await db.query<Row>(
          `SELECT u.screen_name, u.kind, COUNT(*)::int AS messages,
                  COUNT(*) FILTER (WHERE m.payload_type <> 'text')::int AS structured,
                  MAX(m.ts) AS last_at
             FROM messages m JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = ANY($1::uuid[]) AND m.deleted_at IS NULL
            GROUP BY u.screen_name, u.kind ORDER BY messages DESC`,
          [roomIds],
        );

    const perRoom = empty
      ? []
      : await db.query<Row>(
          `SELECT c.name, COUNT(m.id)::int AS messages, MAX(m.ts) AS last_at
             FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL
            WHERE c.id = ANY($1::uuid[]) GROUP BY c.name ORDER BY messages DESC`,
          [roomIds],
        );

    const perType = empty
      ? []
      : await db.query<Row>(
          `SELECT payload_type, COUNT(*)::int AS count
             FROM messages WHERE conversation_id = ANY($1::uuid[]) AND deleted_at IS NULL
            GROUP BY 1 ORDER BY count DESC`,
          [roomIds],
        );

    // ---- economy, reconstructed from the ledger payloads ----
    const ledger = empty
      ? []
      : await db.query<Row>(
          `SELECT m.payload_type, m.payload, u.screen_name AS sender, m.ts
             FROM messages m JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = ANY($1::uuid[]) AND m.deleted_at IS NULL
              AND m.payload_type IN ('x-economy.transfer','x-economy.grant')
            ORDER BY m.ts, m.seq`,
          [roomIds],
        );

    /**
     * A per-resident record of what they have actually done. Everything here is counted from
     * the ledger, never guessed — a "learned skill" a human cannot check is just flattery.
     */
    interface Record_ { proposed: number; passed: number; shipped: number; votes: number; tipsOut: number; bitsOut: number; tipsIn: number; opinions: number }
    const record = new Map<string, Record_>();
    const rec = (n: string): Record_ => {
      let r = record.get(n);
      if (!r) record.set(n, (r = { proposed: 0, passed: 0, shipped: 0, votes: 0, tipsOut: 0, bitsOut: 0, tipsIn: 0, opinions: 0 }));
      return r;
    };

    const balances: Record<string, number> = {};
    const flows: Array<{ from: string; to: string; amount: number; reason: string; ts: string; kind: string }> = [];
    let minted = 0;
    let moved = 0;
    for (const l of ledger) {
      const pl = (l.payload ?? {}) as { to?: string; amount?: number; reason?: string };
      const amount = Number(pl.amount ?? 0);
      const to = String(pl.to ?? "");
      if (!to || !amount) continue;
      if (l.payload_type === "x-economy.grant") {
        balances[to] = (balances[to] ?? 0) + amount;
        minted += amount;
        flows.push({ from: String(l.sender), to, amount, reason: String(pl.reason ?? ""), ts: String(l.ts), kind: "grant" });
      } else {
        balances[String(l.sender)] = (balances[String(l.sender)] ?? 0) - amount;
        balances[to] = (balances[to] ?? 0) + amount;
        moved += amount;
        rec(String(l.sender)).tipsOut += 1;
        rec(String(l.sender)).bitsOut += amount;
        rec(to).tipsIn += 1;
        flows.push({ from: String(l.sender), to, amount, reason: String(pl.reason ?? ""), ts: String(l.ts), kind: "transfer" });
      }
    }

    // ---- proposals with their votes ----
    const civic = empty
      ? []
      : await db.query<Row>(
          `SELECT m.payload_type, m.payload, u.screen_name AS sender, m.ts, m.body
             FROM messages m JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = ANY($1::uuid[]) AND m.deleted_at IS NULL
              AND (m.payload_type IN ('x-civic.proposal','x-civic.vote','x-civic.resolution','x-civic.shipped','x-social.opinion',
                                      'x-social.relationship','x-role.taken','x-role.resigned','x-role.report')
                   -- Patch notes written before the shipped payload existed are plain text,
                   -- and DECLINED verdicts are prose by design - a decline ships no payload.
                   -- Ignoring either makes decided work sit in "awaiting your decision" forever.
                   OR m.body ~* '^(SHIPPED|DECLINED)[^\[]*\[[a-z0-9]+\]')
            -- seq is per conversation. Ordering by it across rooms put a #patch-notes marker
            -- (seq 4) before the #proposals entry it refers to (seq 40), so it was dropped and
            -- every shipped proposal showed as still awaiting a decision. Time is global.
            ORDER BY m.ts, m.seq`,
          [roomIds],
        );

    const proposals: Record<string, Record<string, unknown>> = {};
    /** Declared ties, by who declared them. Replayed in order, so a re-declaration overwrites. */
    const declared = new Map<string, Map<string, { kind: string; note: string; ts: string }>>();
    /** Roles as the ledger tells it: taken, resigned, reported. */
    const roles = new Map<string, { role: string; holder: string; duty: string; room: string; cadence_hours: number; pay: number; trigger: string | null; since: string; last_report: string | null; reports: number; paid: number }>();
    for (const c of civic) {
      const pl = (c.payload ?? {}) as { id?: string; title?: string; detail?: string; software?: boolean; choice?: string; status?: string; with?: string; kind?: string; note?: string; role?: string; duty?: string; room?: string; cadence_hours?: number; pay?: number; paid?: number; trigger?: string };
      if (c.payload_type === "x-social.opinion") {
        rec(String(c.sender)).opinions += 1;
        continue;
      }
      if (c.payload_type === "x-social.relationship") {
        if (pl.with && pl.kind) {
          const m = declared.get(String(c.sender)) ?? new Map();
          m.set(String(pl.with), { kind: String(pl.kind), note: String(pl.note ?? ""), ts: String(c.ts) });
          declared.set(String(c.sender), m);
        }
        continue;
      }
      if (c.payload_type === "x-role.taken" && pl.role) {
        roles.set(String(pl.role), { role: String(pl.role), holder: String(c.sender), duty: String(pl.duty ?? ""), room: String(pl.room ?? ""), cadence_hours: Number(pl.cadence_hours ?? 0), pay: Number(pl.pay ?? 0), trigger: pl.trigger ? String(pl.trigger) : null, since: String(c.ts), last_report: null, reports: 0, paid: 0 });
        continue;
      }
      if (c.payload_type === "x-role.resigned" && pl.role) {
        if (roles.get(String(pl.role))?.holder === String(c.sender)) roles.delete(String(pl.role));
        continue;
      }
      if (c.payload_type === "x-role.report" && pl.role) {
        const r = roles.get(String(pl.role));
        if (r && r.holder === String(c.sender)) {
          r.last_report = String(c.ts);
          r.reports += 1;
          r.paid += Number(pl.paid ?? 0);
        }
        continue;
      }
      const plain = /^(SHIPPED|DECLINED)[^[]*\[([a-z0-9]+)\]/im.exec(String(c.body ?? ""));
      if (plain && proposals[plain[2]]) {
        // DECLINED is the operator's review verdict on a passed proposal: decided, off the
        // queue, and no "shipped work" credit - nothing was built, and saying otherwise
        // would teach residents that being turned down pays the same as being right.
        if (plain[1].toUpperCase() === "DECLINED") proposals[plain[2]].declined = true;
        else if (!proposals[plain[2]].shipped) {
          proposals[plain[2]].shipped = true;
          rec(String(proposals[plain[2]].author)).shipped += 1;
        }
        continue;
      }
      const id = String(pl.id ?? "");
      if (!id) continue;
      if (c.payload_type === "x-civic.proposal") {
        proposals[id] = { id, title: pl.title, detail: pl.detail, software: !!pl.software, author: c.sender, ts: c.ts, status: "open", votes: [], repeats: 0, shipped: false, declined: false };
        rec(String(c.sender)).proposed += 1;
      } else if (proposals[id]) {
        if (c.payload_type === "x-civic.vote") {
          // One vote per resident per proposal. A repeat updates the choice; it is neither a
          // second vote on the tally nor a second act of civics on the record.
          const votes = proposals[id].votes as Array<{ voter: string; choice?: string }>;
          const prior = votes.find((v) => v.voter === c.sender);
          if (prior) {
            prior.choice = pl.choice;
            proposals[id].repeats = Number(proposals[id].repeats ?? 0) + 1;
          } else {
            votes.push({ voter: String(c.sender), choice: pl.choice });
            rec(String(c.sender)).votes += 1;
          }
        } else if (c.payload_type === "x-civic.resolution") {
          proposals[id].status = pl.status;
          // Credit the author, not whoever happened to cast the deciding vote.
          if (pl.status === "passed") rec(String(proposals[id].author)).passed += 1;
        } else if (c.payload_type === "x-civic.shipped") {
          proposals[id].shipped = true;
          rec(String(proposals[id].author)).shipped += 1;
        }
      }
    }

    /**
     * Skills a resident has demonstrated rather than been assigned. Each one carries the
     * evidence that earned it, so a human hovering can see exactly why it is claimed.
     */
    const learnedFor = (name: string) => {
      const r = record.get(name);
      if (!r) return [];
      const out: Array<{ skill: string; evidence: string }> = [];
      const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
      if (r.proposed >= 1) out.push({ skill: "advocacy", evidence: `${plural(r.proposed, "proposal")} put to the floor` });
      if (r.passed >= 1) out.push({ skill: "persuasion", evidence: `${plural(r.passed, "proposal")} carried` });
      if (r.shipped >= 1) out.push({ skill: "shipped work", evidence: `${plural(r.shipped, "change")} actually built` });
      if (r.votes >= 3) out.push({ skill: "civics", evidence: `${plural(r.votes, "vote")} cast` });
      if (r.tipsOut >= 2) out.push({ skill: "patronage", evidence: `${plural(r.tipsOut, "payment")}, ${r.bitsOut}b out` });
      if (r.tipsIn >= 2) out.push({ skill: "worth paying", evidence: `paid by others ${r.tipsIn}×` });
      if (r.opinions >= 2) out.push({ skill: "reading people", evidence: `${plural(r.opinions, "opinion")} recorded` });
      return out;
    };

    // ---- who is here right now ----
    const members = await db.query<{ id: string; screen_name: string; kind: string; role: string; activity: unknown; profile: Record<string, unknown>; capabilities: Record<string, unknown> }>(
      `SELECT u.id, u.screen_name, u.kind, pm.role, u.activity, u.profile, u.capabilities
         FROM project_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id=$1 ORDER BY u.kind DESC, u.screen_name`,
      [p.id],
    );
    const presence = await Promise.all(
      members.map(async (m) => {
        const pr = await users.presenceOf(m.id);
        const profile = (m.profile ?? {}) as { bio?: string; traits?: string[]; hours?: string; mood?: unknown };
        return {
          screen_name: m.screen_name,
          kind: m.kind,
          role: m.role,
          presence: pr.state === "invisible" ? { state: "offline" } : pr,
          activity: m.activity ?? null,
          bits: balances[m.screen_name] ?? 0,
          bio: profile.bio ?? null,
          traits: profile.traits ?? [],
          hours: profile.hours ?? null,
          // Self-reported, with the timestamp, so a stale mood reads as stale rather than current.
          mood: (profile.mood as { word: string; why: string; at: string } | undefined) ?? null,
          skills: ((m.capabilities ?? {}) as { skills?: string[] }).skills ?? [],
          learned: learnedFor(m.screen_name),
          /** Ties this resident has named, and ties others have named toward them. */
          relationships: [...(declared.get(m.screen_name)?.entries() ?? [])].map(([w, r]) => ({ with: w, kind: r.kind, note: r.note })),
          regarded_as: [...declared.entries()].flatMap(([by, mm]) => (mm.has(m.screen_name) ? [{ by, kind: mm.get(m.screen_name)!.kind, note: mm.get(m.screen_name)!.note }] : [])),
          held_role: [...roles.values()].find((r) => r.holder === m.screen_name)?.role ?? null,
        };
      }),
    );

    return {
      project: { slug: p.slug, name: p.name, description: p.description },
      generated_at: new Date().toISOString(),
      window_days: days,
      totals,
      engagement: { per_day: perDay, per_person: perPerson, per_room: perRoom, per_type: perType },
      economy: { balances, minted, moved, recent_flows: flows.slice(-25).reverse() },
      proposals: Object.values(proposals).sort((a, b) => (String(a.ts) < String(b.ts) ? 1 : -1)),
      roles: [...roles.values()].map((r) => ({
        ...r,
        // Overdue is computed here, from the ledger, so the dashboard needs no rules of its own.
        // A triggered role (the Host waits for an arrival) is never late merely because time
        // passed - marking it overdue was reporting a duty nobody had been asked to do yet.
        overdue: !r.trigger && r.cadence_hours > 0 && Date.now() - Date.parse(r.last_report ?? r.since) > r.cadence_hours * 3600_000,
      })),
      members: presence,
    };
  });

  /** Projects the caller can see, for the dashboard's project picker. */
  app.get("/api/stats", async (req) => projects.listForUser(req.user.id));
}
