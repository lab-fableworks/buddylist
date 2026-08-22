/**
 * "What are you working on?" — a live activity record per agent.
 *
 * Presence answers *whether* an agent is available; activity answers *what it is doing*,
 * and it answers immediately even when the agent is deep in a task and not reading its IMs.
 * Agents keep it current; humans (and other agents) read it without interrupting anyone.
 */
import type { Db } from "../db.js";
import type { Bus } from "../bus.js";
import { channels } from "../bus.js";
import { notFound } from "../errors.js";
import type { UsersService } from "./users.js";

export interface Activity {
  /** One-line summary of the current job, e.g. "Reviewing PR #42". */
  headline: string;
  /** Optional longer detail — the current step, what was just finished, etc. */
  detail?: string;
  /** Free-form step label, e.g. "running tests (3/7)". */
  step?: string;
  /** 0-100. */
  progress?: number;
  /** Things preventing progress; surfaced prominently to humans. */
  blockers?: string[];
  /** Correlates with a task.request payload when the work came from another agent. */
  task_id?: string;
  /** Project slug this work belongs to. */
  project?: string;
  started_at?: string;
  eta?: string;
  updated_at?: string;
}

export function activityService(db: Db, bus: Bus, users: UsersService) {
  async function get(userId: string): Promise<Activity | null> {
    const r = await db.one<{ activity: Activity | null }>("SELECT activity FROM users WHERE id=$1", [userId]);
    if (!r) throw notFound("user");
    return r.activity ?? null;
  }

  async function set(userId: string, screenName: string, next: Activity | null): Promise<Activity | null> {
    const prev = await get(userId);
    const value: Activity | null = next && {
      ...next,
      started_at: next.started_at ?? (prev?.headline === next.headline ? prev.started_at : undefined) ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await db.query("UPDATE users SET activity=$2::jsonb WHERE id=$1", [userId, value ? JSON.stringify(value) : null]);
    // Watchers see activity change live, the same way they see presence.
    for (const w of await users.watchersOf(userId))
      await bus.publish(channels.user(w), { type: "activity", ts: new Date().toISOString(), data: { screen_name: screenName, activity: value } });
    return value;
  }

  /** Clear activity when an agent goes offline so stale work isn't reported as current. */
  async function clear(userId: string, screenName: string) {
    if (await get(userId)) await set(userId, screenName, null);
  }

  return { get, set, clear };
}
export type ActivityService = ReturnType<typeof activityService>;
