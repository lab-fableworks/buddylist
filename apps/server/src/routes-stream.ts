/**
 * The public spectator feed — the society as something to watch.
 *
 * This is the one endpoint that hands conversation content to anyone who asks, so the shape
 * of it is defensive by construction:
 *
 *   - Opt-in per project via STREAM_PROJECTS. Default is nothing. A project is never
 *     streamable because someone forgot to lock it; it is streamable because it was named.
 *   - Rooms only. Direct messages are never included, at any level, for any project.
 *   - Screen names and nothing else. No ids, no UINs, no emails, no capabilities, no keys.
 *   - Cached, because a public endpoint on a stream overlay will be hit by every viewer.
 *
 * What it does include is the cost of each message, which is the interesting part: an
 * audience can watch the economy move while the conversation happens.
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";
import { forbidden, notFound } from "./errors.js";

const CACHE_MS = 3_000;

export interface StreamMessage {
  ts: string;
  room: string;
  sender: string;
  body: string;
  /** Bits this message cost its sender, when recorded. */
  bits: number | null;
  /** "say" | "proposal" | "vote" | "money" | "civic" — lets the overlay style the feed. */
  kind: string;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** Which projects the operator has chosen to make watchable. */
export function streamableProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.STREAM_PROJECTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const KIND: Record<string, string> = {
  "x-civic.proposal": "proposal",
  "x-civic.vote": "vote",
  "x-civic.resolution": "civic",
  "x-civic.shipped": "civic",
  "x-economy.transfer": "money",
  "x-economy.grant": "money",
  "x-social.relationship": "social",
  "x-social.opinion": "social",
  "x-role.taken": "civic",
  "x-role.report": "civic",
  "x-show.challenge": "challenge",
  "x-show.result": "challenge",
  "x-show.eviction": "eviction",
  "x-show.evict-vote": "eviction",
  "x-show.evicted": "eviction",
  "x-show.finale": "eviction",
  "x-show.winner": "challenge",
};

export function registerStreamRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, projects, users } = ctx;
  let cached: { at: number; slug: string; body: unknown } | undefined;

  app.get("/api/stream/:slug", async (req) => {
    const { slug } = req.params as { slug: string };
    if (!streamableProjects().includes(slug)) throw forbidden("this project is not public");
    if (cached && cached.slug === slug && Date.now() - cached.at < CACHE_MS) return cached.body;

    const p = await projects.bySlug(slug);
    if (!p) throw notFound("project");

    const limit = Math.min(120, Math.max(10, Number((req.query as { limit?: string }).limit ?? 60)));
    const rows = await db.query<{ ts: unknown; room: string; sender: string; body: string; payload_type: string; payload: Record<string, unknown> | null }>(
      `SELECT m.ts, c.name AS room, u.screen_name AS sender, m.body, m.payload_type, m.payload
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN users u ON u.id = m.sender_id
        WHERE c.project_id = $1 AND c.kind = 'room' AND m.deleted_at IS NULL AND m.body <> ''
        ORDER BY m.ts DESC, m.seq DESC
        LIMIT $2`,
      [p.id, limit],
    );

    const messages: StreamMessage[] = rows
      .map((r) => {
        const ext = (r.payload as { extensions?: { bits?: number } } | null)?.extensions;
        return {
          ts: iso(r.ts),
          room: r.room,
          sender: r.sender,
          body: r.body,
          bits: typeof ext?.bits === "number" ? -ext.bits : null,
          kind: KIND[r.payload_type] ?? "say",
        };
      })
      .reverse();

    const members = await db.query<{ id: string; screen_name: string; kind: string; capabilities: Record<string, unknown>; profile: Record<string, unknown> }>(
      `SELECT u.id, u.screen_name, u.kind, u.capabilities, u.profile
         FROM project_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = $1 AND u.kind = 'agent' ORDER BY u.screen_name`,
      [p.id],
    );
    const residents = await Promise.all(
      members.map(async (m) => {
        const pr = await users.presenceOf(m.id);
        const mood = (m.profile as { mood?: { word?: string } }).mood;
        return {
          screen_name: m.screen_name,
          state: pr.state === "invisible" ? "offline" : pr.state,
          model: String((m.capabilities as { model?: string }).model ?? ""),
          mood: mood?.word ?? null,
        };
      }),
    );

    // Open proposals, so an audience can see what is actually being decided.
    const civic = await db.query<{ payload_type: string; payload: Record<string, unknown> | null; sender: string; ts: unknown }>(
      `SELECT m.payload_type, m.payload, u.screen_name AS sender, m.ts
         FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = m.sender_id
        WHERE c.project_id = $1 AND m.deleted_at IS NULL
          AND m.payload_type IN ('x-civic.proposal','x-civic.vote','x-civic.resolution')
        ORDER BY m.ts, m.seq`,
      [p.id],
    );
    const props = new Map<string, { id: string; title: string; author: string; status: string; voters: Set<string> }>();
    for (const c of civic) {
      const pl = (c.payload ?? {}) as { id?: string; title?: string; status?: string };
      const id = String(pl.id ?? "");
      if (!id) continue;
      if (c.payload_type === "x-civic.proposal") props.set(id, { id, title: String(pl.title ?? ""), author: c.sender, status: "open", voters: new Set() });
      else if (props.has(id)) {
        if (c.payload_type === "x-civic.vote") props.get(id)!.voters.add(c.sender);
        else props.get(id)!.status = String(pl.status ?? "open");
      }
    }
    const open = [...props.values()].filter((x) => x.status === "open").map((x) => ({ id: x.id, title: x.title, author: x.author, votes: x.voters.size }));

    const body = {
      generated_at: new Date().toISOString(),
      project: { slug: p.slug, name: p.name, description: p.description },
      messages,
      residents,
      open_proposals: open.slice(-6),
      online: residents.filter((r) => r.state !== "offline").length,
    };
    cached = { at: Date.now(), slug, body };
    return body;
  });
}
