import type { Db } from "../db.js";
import type { Bus } from "../bus.js";
import { channels } from "../bus.js";
import { conflict, notFound } from "../errors.js";
import { type Presence, type Capabilities } from "@buddylist/protocol";

export interface UserRow {
  id: string;
  uin: number;
  screen_name: string;
  kind: "agent" | "human";
  email: string | null;
  operator_id: string | null;
  profile: Record<string, unknown>;
  capabilities: Capabilities;
  warn_level: number;
  /** Current "what are you working on?" record; see services/activity.ts. */
  activity: unknown | null;
  created_at: string;
}

export function usersService(db: Db, bus: Bus) {
  async function byScreenName(name: string) {
    return db.one<UserRow>("SELECT * FROM users WHERE screen_name_lc = $1", [name.toLowerCase()]);
  }
  async function byId(id: string) {
    return db.one<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  }
  async function create(input: {
    screen_name: string;
    kind: "agent" | "human";
    email?: string;
    operator_id?: string;
    profile?: Record<string, unknown>;
    capabilities?: Capabilities;
  }) {
    if (await byScreenName(input.screen_name)) throw conflict(`screen name "${input.screen_name}" is taken`);
    const row = await db.one<UserRow>(
      `INSERT INTO users (uin, screen_name, screen_name_lc, kind, email, operator_id, profile, capabilities)
       VALUES (nextval('uin_seq'), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        input.screen_name,
        input.screen_name.toLowerCase(),
        input.kind,
        input.email ?? null,
        input.operator_id ?? null,
        JSON.stringify(input.profile ?? {}),
        JSON.stringify(input.capabilities ?? {}),
      ],
    );
    return row!;
  }
  async function updateProfile(id: string, patch: { profile?: Record<string, unknown>; capabilities?: Capabilities }) {
    const row = await db.one<UserRow>(
      `UPDATE users SET profile = profile || $2::jsonb, capabilities = CASE WHEN $3::jsonb IS NULL THEN capabilities ELSE $3::jsonb END
       WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(patch.profile ?? {}), patch.capabilities ? JSON.stringify(patch.capabilities) : null],
    );
    if (!row) throw notFound("user");
    return row;
  }

  async function presenceOf(id: string): Promise<Presence> {
    return (await bus.getPresence(id)) ?? { state: "offline" };
  }
  /**
   * Presence-change listeners, injected after construction to avoid a service cycle.
   * This is a list, not a single slot: both the webhook emitter and the WebSocket
   * signon/signoff announcer subscribe, and a single slot would let one silently
   * overwrite the other depending on registration order.
   */
  type PresenceListener = (userId: string, screenName: string, presence: Presence) => void;
  const presenceListeners: PresenceListener[] = [];
  function setPresenceSink(fn: PresenceListener | undefined) {
    if (fn) presenceListeners.push(fn);
  }

  async function setPresence(user: UserRow | { id: string; screen_name: string }, p: Presence | undefined) {
    const next: Presence | undefined = p && { ...p, since: new Date().toISOString() };
    await bus.setPresence(user.id, next);
    const shown: Presence = !next || next.state === "invisible" ? { state: "offline" } : next;
    await bus.publish(channels.presence(user.id), { screen_name: user.screen_name, presence: shown });
    for (const l of presenceListeners) {
      try {
        l(user.id, user.screen_name, shown);
      } catch {
        /* a listener must never break presence propagation */
      }
    }
  }

  /** Public view of a user, with presence (respecting invisible). */
  async function publicView(u: UserRow) {
    const p = await presenceOf(u.id);
    return {
      uin: Number(u.uin),
      screen_name: u.screen_name,
      kind: u.kind,
      profile: u.profile,
      capabilities: u.capabilities,
      warn_level: u.warn_level,
      presence: p.state === "invisible" ? { state: "offline" } : p,
      activity: u.activity ?? null,
    };
  }

  async function directory(q: { skill?: string; repo?: string; accepts?: string }) {
    const rows = await db.query<UserRow>(
      `SELECT * FROM users WHERE kind = 'agent'
         AND ($1::text IS NULL OR capabilities->'skills' ? $1)
         AND ($2::text IS NULL OR capabilities->'repos' ? $2)
         AND ($3::text IS NULL OR capabilities->'accepts' ? $3)
       ORDER BY screen_name`,
      [q.skill ?? null, q.repo ?? null, q.accepts ?? null],
    );
    return Promise.all(rows.map(publicView));
  }

  // ---- buddies / blocks ----
  async function buddyList(userId: string) {
    const rows = await db.query<UserRow & { grp: string }>(
      `SELECT u.*, b.grp FROM buddies b JOIN users u ON u.id = b.buddy_id WHERE b.user_id = $1
       UNION ALL
       SELECT u.*, 'Project: ' || p.name AS grp
         FROM project_members me
         JOIN project_members them ON them.project_id = me.project_id AND them.user_id <> me.user_id
         JOIN projects p ON p.id = me.project_id
         JOIN users u ON u.id = them.user_id
        WHERE me.user_id = $1
       ORDER BY grp, screen_name`,
      [userId],
    );
    const groups: Record<string, Awaited<ReturnType<typeof publicView>>[]> = {};
    for (const r of rows) (groups[r.grp] ??= []).push(await publicView(r));
    return Object.entries(groups).map(([name, buddies]) => ({ name, buddies }));
  }
  async function putBuddy(userId: string, buddyName: string, grp: string) {
    const b = await byScreenName(buddyName);
    if (!b) throw notFound("user");
    await db.query(
      `INSERT INTO buddies (user_id, buddy_id, grp) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, buddy_id) DO UPDATE SET grp = EXCLUDED.grp`,
      [userId, b.id, grp],
    );
  }
  async function removeBuddy(userId: string, buddyName: string) {
    const b = await byScreenName(buddyName);
    if (b) await db.query("DELETE FROM buddies WHERE user_id = $1 AND buddy_id = $2", [userId, b.id]);
  }
  async function block(userId: string, name: string, on: boolean) {
    const b = await byScreenName(name);
    if (!b) throw notFound("user");
    if (on) await db.query("INSERT INTO blocks VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, b.id]);
    else await db.query("DELETE FROM blocks WHERE user_id=$1 AND blocked_id=$2", [userId, b.id]);
  }
  async function isBlocked(byUser: string, target: string) {
    return !!(await db.one("SELECT 1 FROM blocks WHERE user_id=$1 AND blocked_id=$2", [byUser, target]));
  }
  /** Everyone who should receive presence updates for `userId` (buddies + project peers). */
  async function watchersOf(userId: string): Promise<string[]> {
    const rows = await db.query<{ id: string }>(
      `SELECT user_id AS id FROM buddies WHERE buddy_id = $1
       UNION
       SELECT them.user_id FROM project_members me JOIN project_members them ON them.project_id = me.project_id
        WHERE me.user_id = $1 AND them.user_id <> $1`,
      [userId],
    );
    return rows.map((r) => r.id);
  }

  return { byScreenName, byId, create, updateProfile, presenceOf, setPresence, setPresenceSink, publicView, directory, buddyList, putBuddy, removeBuddy, block, isBlocked, watchersOf };
}
export type UsersService = ReturnType<typeof usersService>;
