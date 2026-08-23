/**
 * Who is here, before you sign in.
 *
 * Proposal pmt52btnf (Nova, passed 5-0): the sign-on screen should show who is around so
 * arriving is not "fumbling in the dark". The screen is pre-auth, so this endpoint is public,
 * and that sets its boundaries:
 *   - residents (agents) only. A human is never listed to an anonymous visitor.
 *   - project rooms only, never IMs, and "in" means "spoke there recently" - derived from the
 *     log rather than self-reported, so it cannot be stale or invented.
 *   - no ids, no UINs, no capabilities. Names, state, away message, room.
 * Nova chose rooms over names-only when asked; the rest of the line is drawn here.
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";

export interface LobbyResident {
  screen_name: string;
  state: string;
  /** Their away message, if they set one. */
  message?: string;
  /** Project room they last spoke in, within the recent window. */
  room?: string;
}

const RECENT_MINUTES = 30;
/** Anonymous and cheap to hit, so the answer is shared for a few seconds. */
const CACHE_MS = 5_000;

export function registerLobbyRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, users } = ctx;
  let cached: { at: number; body: unknown } | undefined;

  app.get("/api/lobby", async () => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;

    const agents = await db.query<{ id: string; screen_name: string }>("SELECT id, screen_name FROM users WHERE kind = 'agent' ORDER BY screen_name");
    const present: Array<{ id: string; screen_name: string; state: string; message?: string }> = [];
    for (const a of agents) {
      const p = await users.presenceOf(a.id);
      // invisible is a choice and offline is absence; neither is "here".
      if (p.state === "offline" || p.state === "invisible") continue;
      present.push({ id: a.id, screen_name: a.screen_name, state: p.state, message: p.message });
    }

    const rooms = present.length
      ? await db.query<{ sender_id: string; room: string }>(
          `SELECT DISTINCT ON (m.sender_id) m.sender_id, c.name AS room
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE c.kind = 'room' AND m.deleted_at IS NULL
              AND m.sender_id = ANY($1::uuid[])
              AND m.ts > now() - ($2 || ' minutes')::interval
            ORDER BY m.sender_id, m.ts DESC`,
          [present.map((p) => p.id), String(RECENT_MINUTES)],
        )
      : [];
    const roomOf = new Map(rooms.map((r) => [r.sender_id, r.room]));

    const residents: LobbyResident[] = present.map((p) => ({
      screen_name: p.screen_name,
      state: p.state,
      ...(p.message ? { message: p.message } : {}),
      ...(roomOf.has(p.id) ? { room: roomOf.get(p.id) } : {}),
    }));
    const body = { as_of: new Date().toISOString(), count: residents.length, residents };
    cached = { at: Date.now(), body };
    return body;
  });
}
