/**
 * Outbound webhooks: registration + at-least-once delivery with HMAC signatures and retry.
 *
 * Signature scheme (documented for integrators):
 *   Each delivery POST carries:
 *     X-BuddyList-Event:     the event name (e.g. "mention")
 *     X-BuddyList-Delivery:  the webhook_deliveries.id (UUID) — use for idempotency
 *     X-BuddyList-Timestamp: unix seconds at send time
 *     X-BuddyList-Signature: sha256=<hex>, an HMAC-SHA256 over the exact string
 *                            `${timestamp}.${rawBody}` (rawBody = the exact bytes sent as the
 *                            request body, i.e. JSON.stringify(payload)), keyed with the
 *                            webhook's secret. To verify: recompute the HMAC over
 *                            `${X-BuddyList-Timestamp}.${rawBody}` with your secret and compare
 *                            (constant-time) against the hex digest after "sha256=".
 */
import crypto from "node:crypto";
import type { Db } from "../db.js";
import type { Bus } from "../bus.js";
import { channels } from "../bus.js";
import type { UsersService } from "./users.js";
import { badRequest, notFound } from "../errors.js";

export const WEBHOOK_EVENTS = ["im.received", "mention", "room.message", "buddy.presence", "task.request", "ping"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookRow {
  id: string;
  user_id: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  active: boolean;
  created_at: string;
}

export interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  last_status: number | null;
  next_retry_at: string;
  created_at: string;
}

export interface WebhooksOptions {
  /** How often the delivery worker polls for due rows. Default 1000ms; tests override for speed. */
  pollIntervalMs?: number;
  /** Backoff schedule (ms) applied after attempt 1, 2, 3, ... Length also caps max attempts. */
  backoffMs?: number[];
  /** Per-request abort timeout. Default 10s. */
  requestTimeoutMs?: number;
  /** Rows fetched per poll. */
  batchSize?: number;
}

type RawRow = Omit<WebhookRow, "events"> & { events: unknown };
const parseEvents = (raw: unknown): WebhookEvent[] => {
  if (Array.isArray(raw)) return raw as WebhookEvent[];
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? (v as WebhookEvent[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};
const toWebhook = (r: RawRow): WebhookRow => ({ ...r, events: parseEvents(r.events) });
const stripSecret = ({ secret: _secret, ...rest }: WebhookRow): Omit<WebhookRow, "secret"> => rest;

export function webhooksService(db: Db, bus: Bus, users: UsersService, opts: WebhooksOptions = {}) {
  void users; // reserved for future per-event authorization/filters
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const backoffMs = opts.backoffMs ?? [10_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
  const maxAttempts = backoffMs.length;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const batchSize = opts.batchSize ?? 20;

  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  // userId -> unsubscribe, for users who have at least one active webhook (any event).
  const userSubs = new Map<string, () => void>();

  function onUserFrame(userId: string) {
    return (_channel: string, frame: unknown) => {
      const f = frame as { type?: string; data?: unknown } | undefined;
      if (!f || !f.type || f.type === "_subscribe") return;
      // Only forward frame types that are also webhook event names (currently: mention).
      if ((WEBHOOK_EVENTS as readonly string[]).includes(f.type)) void emit(userId, f.type as WebhookEvent, f.data);
    };
  }

  function ensureSubscribed(userId: string) {
    if (userSubs.has(userId)) return;
    userSubs.set(userId, bus.subscribe(channels.user(userId), onUserFrame(userId)));
  }

  async function maybeUnsubscribe(userId: string) {
    const stillHasActive = await db.one<{ x: number }>("SELECT 1 AS x FROM webhooks WHERE user_id=$1 AND active LIMIT 1", [userId]);
    if (!stillHasActive) {
      userSubs.get(userId)?.();
      userSubs.delete(userId);
    }
  }

  async function refreshSubscriptions() {
    const rows = await db.query<{ user_id: string }>("SELECT DISTINCT user_id FROM webhooks WHERE active");
    for (const r of rows) ensureSubscribed(r.user_id);
  }

  // ---- registration / CRUD ----

  async function create(userId: string, input: { url: string; events: string[]; secret?: string }): Promise<WebhookRow> {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw badRequest("url must be a valid http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest("url must be http(s)");
    if (!Array.isArray(input.events) || input.events.length === 0) throw badRequest("events must be a non-empty array");
    for (const e of input.events) if (!(WEBHOOK_EVENTS as readonly string[]).includes(e)) throw badRequest(`unknown event "${e}"`);
    const secret = input.secret && input.secret.length >= 8 ? input.secret : crypto.randomBytes(24).toString("hex");
    const row = await db.one<RawRow>(
      `INSERT INTO webhooks (user_id, url, events, secret, active) VALUES ($1, $2, $3::jsonb, $4, true) RETURNING *`,
      [userId, input.url, JSON.stringify(input.events), secret],
    );
    ensureSubscribed(userId);
    return toWebhook(row!);
  }

  async function list(userId: string): Promise<Omit<WebhookRow, "secret">[]> {
    const rows = await db.query<RawRow>("SELECT * FROM webhooks WHERE user_id=$1 ORDER BY created_at", [userId]);
    return rows.map(toWebhook).map(stripSecret);
  }

  async function getOwned(userId: string, id: string): Promise<WebhookRow> {
    const row = await db.one<RawRow>("SELECT * FROM webhooks WHERE id=$1", [id]);
    if (!row || row.user_id !== userId) throw notFound("webhook");
    return toWebhook(row);
  }

  async function remove(userId: string, id: string): Promise<void> {
    await getOwned(userId, id);
    await db.query("DELETE FROM webhooks WHERE id=$1", [id]);
    await maybeUnsubscribe(userId);
  }

  async function update(userId: string, id: string, patch: { active?: boolean; events?: string[]; url?: string }): Promise<Omit<WebhookRow, "secret">> {
    const existing = await getOwned(userId, id);
    let url = existing.url;
    if (patch.url !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(patch.url);
      } catch {
        throw badRequest("url must be a valid http(s) URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest("url must be http(s)");
      url = patch.url;
    }
    let events = existing.events;
    if (patch.events !== undefined) {
      if (!Array.isArray(patch.events) || patch.events.length === 0) throw badRequest("events must be a non-empty array");
      for (const e of patch.events) if (!(WEBHOOK_EVENTS as readonly string[]).includes(e)) throw badRequest(`unknown event "${e}"`);
      events = patch.events as WebhookEvent[];
    }
    const active = patch.active !== undefined ? patch.active : existing.active;
    const row = await db.one<RawRow>(
      `UPDATE webhooks SET url=$1, events=$2::jsonb, active=$3 WHERE id=$4 RETURNING *`,
      [url, JSON.stringify(events), active, id],
    );
    if (active) ensureSubscribed(userId);
    else await maybeUnsubscribe(userId);
    return stripSecret(toWebhook(row!));
  }

  async function deliveries(userId: string, id: string, limit = 50): Promise<WebhookDeliveryRow[]> {
    await getOwned(userId, id);
    return db.query<WebhookDeliveryRow>(
      `SELECT id, webhook_id, event, payload, status, attempts, last_error, last_status, next_retry_at, created_at
         FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [id, Math.min(Math.max(limit, 1), 200)],
    );
  }

  async function test(userId: string, id: string): Promise<{ ok: true }> {
    const hook = await getOwned(userId, id);
    await db.query(`INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, 'ping', $2::jsonb)`, [
      hook.id,
      JSON.stringify({ hello: "buddylist", ts: new Date().toISOString() }),
    ]);
    return { ok: true };
  }

  /** Enqueue an event for every active webhook of `userId` subscribed to it. Never throws. */
  async function emit(userId: string, event: string, payload: unknown): Promise<void> {
    try {
      const hooks = await db.query<RawRow>("SELECT * FROM webhooks WHERE user_id=$1 AND active", [userId]);
      for (const h of hooks) {
        const events = parseEvents(h.events);
        if (!events.includes(event as WebhookEvent)) continue;
        await db.query(`INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, $2, $3::jsonb)`, [h.id, event, JSON.stringify(payload ?? null)]);
      }
    } catch (err) {
      // emit() must be cheap and must never throw into the caller (e.g. the mention/bus handler path).
      console.error("[webhooks] emit failed", err);
    }
  }

  // ---- delivery worker ----

  function nextRetryDelay(attemptsSoFar: number): number | undefined {
    // attemptsSoFar is the count *after* this failed attempt (1-based).
    if (attemptsSoFar >= maxAttempts) return undefined;
    return backoffMs[attemptsSoFar - 1] ?? backoffMs[backoffMs.length - 1];
  }

  async function deliverOne(row: WebhookDeliveryRow & { url: string; secret: string }) {
    const rawBody = JSON.stringify(row.payload ?? null);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac("sha256", row.secret).update(`${timestamp}.${rawBody}`).digest("hex");
    let ok = false;
    let statusCode: number | null = null;
    let errorMsg: string | null = null;
    try {
      const res = await fetch(row.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-BuddyList-Event": row.event,
          "X-BuddyList-Delivery": row.id,
          "X-BuddyList-Timestamp": String(timestamp),
          "X-BuddyList-Signature": `sha256=${signature}`,
        },
        body: rawBody,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      statusCode = res.status;
      ok = res.status >= 200 && res.status < 300;
      if (!ok) errorMsg = `HTTP ${res.status}`;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    const attempts = row.attempts + 1;
    if (ok) {
      await db.query(`UPDATE webhook_deliveries SET status='delivered', attempts=$2, last_status=$3, last_error=NULL WHERE id=$1`, [row.id, attempts, statusCode]);
      return;
    }
    const delay = nextRetryDelay(attempts);
    if (delay === undefined) {
      await db.query(`UPDATE webhook_deliveries SET status='failed', attempts=$2, last_status=$3, last_error=$4 WHERE id=$1`, [row.id, attempts, statusCode, errorMsg]);
    } else {
      await db.query(
        `UPDATE webhook_deliveries SET status='pending', attempts=$2, last_status=$3, last_error=$4, next_retry_at = now() + ($5 || ' milliseconds')::interval WHERE id=$1`,
        [row.id, attempts, statusCode, errorMsg, delay],
      );
    }
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const due = await db.query<WebhookDeliveryRow & { url: string; secret: string }>(
        `SELECT d.id, d.webhook_id, d.event, d.payload, d.status, d.attempts, d.last_error, d.last_status, d.next_retry_at, d.created_at, w.url, w.secret
           FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
          WHERE d.status='pending' AND d.next_retry_at <= now() AND w.active
          ORDER BY d.next_retry_at LIMIT $1`,
        [batchSize],
      );
      for (const row of due) await deliverOne(row);
    } catch (err) {
      console.error("[webhooks] poll failed", err);
    } finally {
      polling = false;
    }
  }

  /** Start the background delivery worker (and bus subscriptions for wired events). */
  function start(): void {
    if (timer) return;
    void refreshSubscriptions();
    timer = setInterval(() => void pollOnce(), pollIntervalMs);
    timer.unref?.();
  }
  /** Stop the worker (called on server close). */
  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    for (const unsub of userSubs.values()) unsub();
    userSubs.clear();
  }

  return { emit, start, stop, create, list, remove, update, deliveries, test };
}
export type WebhooksService = ReturnType<typeof webhooksService>;
