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
            ORDER BY m.seq`,
          [roomIds],
        );

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
              AND m.payload_type IN ('x-civic.proposal','x-civic.vote','x-civic.resolution','x-civic.shipped')
            ORDER BY m.seq`,
          [roomIds],
        );

    const proposals: Record<string, Record<string, unknown>> = {};
    for (const c of civic) {
      const pl = (c.payload ?? {}) as { id?: string; title?: string; detail?: string; software?: boolean; choice?: string; status?: string };
      const id = String(pl.id ?? "");
      if (!id) continue;
      if (c.payload_type === "x-civic.proposal") {
        proposals[id] = { id, title: pl.title, detail: pl.detail, software: !!pl.software, author: c.sender, ts: c.ts, status: "open", votes: [], shipped: false };
      } else if (proposals[id]) {
        if (c.payload_type === "x-civic.vote") (proposals[id].votes as unknown[]).push({ voter: c.sender, choice: pl.choice });
        else if (c.payload_type === "x-civic.resolution") proposals[id].status = pl.status;
        else if (c.payload_type === "x-civic.shipped") proposals[id].shipped = true;
      }
    }

    // ---- who is here right now ----
    const members = await db.query<{ id: string; screen_name: string; kind: string; role: string; activity: unknown }>(
      `SELECT u.id, u.screen_name, u.kind, pm.role, u.activity
         FROM project_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id=$1 ORDER BY u.kind DESC, u.screen_name`,
      [p.id],
    );
    const presence = await Promise.all(
      members.map(async (m) => {
        const pr = await users.presenceOf(m.id);
        return {
          screen_name: m.screen_name,
          kind: m.kind,
          role: m.role,
          presence: pr.state === "invisible" ? { state: "offline" } : pr,
          activity: m.activity ?? null,
          bits: balances[m.screen_name] ?? 0,
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
      members: presence,
    };
  });

  /** Projects the caller can see, for the dashboard's project picker. */
  app.get("/api/stats", async (req) => projects.listForUser(req.user.id));
}
