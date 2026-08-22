/**
 * "What needs me?" — the messages addressed to you that you have not answered.
 *
 * Mentions were previously fire-and-forget: published to the bus and never stored, so a
 * mention that arrived while you were offline simply never existed. Rather than start
 * recording them from now on — which would leave every past mention lost — this reads them
 * back out of the message log. The log is already the durable record; anything derived from
 * it is retroactive and cannot drift from what was actually said.
 *
 * Two independent facts about each item, because they answer different questions:
 *   - `unread`  — you have not looked at it (from the read cursor).
 *   - `answered` — you have spoken in that conversation since it arrived.
 * Reading something is not replying to it, so an item stays outstanding until you say
 * something back. That is the whole point of the view.
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";

/** Strongest first: when one conversation triggers several ways, the most demanding wins. */
const REASON_RANK = ["question", "task.request", "review.request", "handoff", "dm", "mention"] as const;
type Reason = (typeof REASON_RANK)[number];

interface Row {
  id: string;
  conversation_id: string;
  seq: number;
  body: string;
  payload_type: string;
  payload: Record<string, unknown> | null;
  ts: string;
  sender: string;
  kind: string;
  room: string | null;
  project: string | null;
  peer: string | null;
  last_read_seq: number;
  my_last: number;
}

export function registerAttentionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get("/api/attention", async (req) => {
    const q = req.query as { days?: string; all?: string; limit?: string };
    const days = Math.min(365, Math.max(1, Number(q.days ?? 30)));
    const includeAnswered = q.all === "1" || q.all === "true";
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const me = req.user.id;
    const name = req.user.screen_name;

    const rows = await db.query<Row>(
      `WITH mine AS (
         SELECT conversation_id, MAX(seq) AS my_last
           FROM messages WHERE sender_id = $1 AND deleted_at IS NULL GROUP BY conversation_id
       )
       SELECT m.id, m.conversation_id, m.seq, m.body, m.payload_type, m.payload, m.ts,
              s.screen_name AS sender, c.kind, c.name AS room, p.slug AS project,
              cm.last_read_seq, COALESCE(mine.my_last, 0) AS my_last,
              (SELECT u.screen_name FROM conv_members o JOIN users u ON u.id = o.user_id
                WHERE o.conversation_id = c.id AND o.user_id <> $1 AND c.kind = 'im' LIMIT 1) AS peer
         FROM messages m
         JOIN conv_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
         JOIN conversations c ON c.id = m.conversation_id
         JOIN users s ON s.id = m.sender_id
         LEFT JOIN projects p ON p.id = c.project_id
         LEFT JOIN mine ON mine.conversation_id = m.conversation_id
        WHERE m.sender_id <> $1
          AND m.deleted_at IS NULL
          AND m.ts > now() - ($2 || ' days')::interval
          AND (
            c.kind = 'im'
            -- Screen names are [A-Za-z0-9_] only, so this interpolation carries no regex
            -- metacharacters. The trailing class is the word boundary, spelled out rather
            -- than written as \y: a backslash escape here depends on
            -- standard_conforming_strings, and silently matches nothing when it is off.
            -- ~* not ~: screen names resolve case-insensitively, so @ZGMcginn already
            -- notifies zgmcginn. A case-sensitive view here would hide real mentions.
            OR m.body ~* ('@' || $3 || '([^A-Za-z0-9_]|$)')
            OR m.payload_type IN ('question','task.request','review.request','handoff')
          )
        ORDER BY m.ts DESC
        LIMIT 2000`,
      [me, String(days), name],
    );

    const reasonOf = (r: Row): Reason | undefined => {
      // Built from a plain string, not a template literal: a template literal turns \b into
      // a backspace character rather than a word boundary, so the pattern matches nothing.
      // The lookahead is the same boundary the SQL spells out, and must stay in step with it.
      const mentioned = new RegExp("@" + name + "(?![A-Za-z0-9_])", "i").test(r.body);
      if (r.payload_type === "question") return "question";
      // A task broadcast to a room is not addressed to you; one sent to you directly, or one
      // that names you, is. Without this every resident's task lands in everyone's queue.
      const directed = r.kind === "im" || mentioned;
      if (r.payload_type === "task.request" && directed) return "task.request";
      if (r.payload_type === "review.request" && directed) return "review.request";
      if (r.payload_type === "handoff" && (r.payload as { to?: string } | null)?.to === name) return "handoff";
      if (r.kind === "im") return "dm";
      if (mentioned) return "mention";
      return undefined;
    };

    // Collapse to one item per conversation. A thread with nine unanswered messages is one
    // thing you owe someone a reply to, not nine.
    interface Item {
      conversation_id: string;
      kind: string;
      room: string | null;
      project: string | null;
      peer: string | null;
      reason: Reason;
      reasons: Reason[];
      triggers: number;
      unread: number;
      answered: boolean;
      latest: { id: string; seq: number; ts: string; sender: string; body: string; payload_type: string };
    }
    const byConv = new Map<string, Item>();
    for (const r of rows) {
      const reason = reasonOf(r);
      if (!reason) continue;
      const answered = r.seq <= r.my_last;
      if (answered && !includeAnswered) continue;
      const existing = byConv.get(r.conversation_id);
      if (!existing) {
        byConv.set(r.conversation_id, {
          conversation_id: r.conversation_id,
          kind: r.kind,
          room: r.room,
          project: r.project,
          peer: r.peer,
          reason,
          reasons: [reason],
          triggers: 1,
          unread: r.seq > r.last_read_seq ? 1 : 0,
          answered,
          // Rows arrive newest-first, so the first one seen is the latest.
          latest: { id: r.id, seq: r.seq, ts: r.ts, sender: r.sender, body: r.body, payload_type: r.payload_type },
        });
        continue;
      }
      existing.triggers += 1;
      if (r.seq > r.last_read_seq) existing.unread += 1;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (REASON_RANK.indexOf(reason) < REASON_RANK.indexOf(existing.reason)) existing.reason = reason;
    }

    const items = [...byConv.values()]
      .sort((a, b) => REASON_RANK.indexOf(a.reason) - REASON_RANK.indexOf(b.reason) || (a.latest.ts < b.latest.ts ? 1 : -1))
      .slice(0, limit);

    return {
      as_of: new Date().toISOString(),
      window_days: days,
      /** Outstanding conversations, not outstanding messages — the count you can act on. */
      total: items.length,
      unread: items.reduce((n, i) => n + i.unread, 0),
      by_reason: Object.fromEntries(REASON_RANK.map((r) => [r, items.filter((i) => i.reason === r).length]).filter(([, n]) => (n as number) > 0)),
      items,
    };
  });
}
