/**
 * Bus = cross-node pub/sub, presence store, and session registry.
 * In-memory for single-node dev; Redis for clusters. Both implementations share the same
 * semantics so multi-node behaviour can be tested by pointing two app instances at one memoryBus.
 *
 * Presence is a *heartbeat*, not a latch. A node with a live socket refreshes it on a timer;
 * if every node holding that user dies, the key expires and they correctly appear offline.
 * That is why `touchSession` exists — without it a Redis-backed deployment would silently
 * mark connected users offline once the TTL elapsed.
 */
import type { Presence } from "@buddylist/protocol";

export type Handler = (channel: string, payload: unknown) => void;

/** How long a presence key / session entry survives without a refresh. */
export const PRESENCE_TTL_MS = 120_000;

export interface Bus {
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, h: Handler): () => void;

  getPresence(userId: string): Promise<Presence | undefined>;
  setPresence(userId: string, p: Presence | undefined): Promise<void>;

  /** Register a live socket. Returns the session count across *all* nodes. */
  addSession(userId: string, sessionId: string): Promise<number>;
  /** Deregister a socket. Returns the remaining count across all nodes. */
  removeSession(userId: string, sessionId: string): Promise<number>;
  /** Refresh this session and the presence TTL. Returns the count across all nodes. */
  touchSession(userId: string, sessionId: string): Promise<number>;
  countSessions(userId: string): Promise<number>;

  /**
   * Set `key` to `value`, reporting whether it changed. Lets exactly one node emit a
   * cross-node transition event (buddy signon/signoff) instead of every node emitting it.
   */
  setIfChanged(key: string, value: string): Promise<boolean>;

  close(): Promise<void>;
}

export function memoryBus(): Bus {
  const subs = new Map<string, Set<Handler>>();
  const presence = new Map<string, { p: Presence; expires: number }>();
  const sessions = new Map<string, Map<string, number>>(); // userId -> sessionId -> lastSeen
  const flags = new Map<string, string>();

  const prune = (userId: string) => {
    const m = sessions.get(userId);
    if (!m) return 0;
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [id, seen] of m) if (seen < cutoff) m.delete(id);
    if (m.size === 0) sessions.delete(userId);
    return m.size;
  };

  return {
    async publish(channel, payload) {
      for (const h of subs.get(channel) ?? []) queueMicrotask(() => h(channel, payload));
    },
    subscribe(channel, h) {
      if (!subs.has(channel)) subs.set(channel, new Set());
      subs.get(channel)!.add(h);
      return () => subs.get(channel)?.delete(h);
    },
    async getPresence(id) {
      const e = presence.get(id);
      if (!e) return undefined;
      if (e.expires < Date.now()) {
        presence.delete(id);
        return undefined;
      }
      return e.p;
    },
    async setPresence(id, p) {
      if (p) presence.set(id, { p, expires: Date.now() + PRESENCE_TTL_MS });
      else presence.delete(id);
    },
    async addSession(userId, sessionId) {
      const m = sessions.get(userId) ?? new Map<string, number>();
      m.set(sessionId, Date.now());
      sessions.set(userId, m);
      return prune(userId);
    },
    async removeSession(userId, sessionId) {
      sessions.get(userId)?.delete(sessionId);
      return prune(userId);
    },
    async touchSession(userId, sessionId) {
      const m = sessions.get(userId) ?? new Map<string, number>();
      m.set(sessionId, Date.now());
      sessions.set(userId, m);
      const e = presence.get(userId);
      if (e) e.expires = Date.now() + PRESENCE_TTL_MS;
      return prune(userId);
    },
    async countSessions(userId) {
      return prune(userId);
    },
    async setIfChanged(key, value) {
      const prev = flags.get(key);
      flags.set(key, value);
      return prev !== value;
    },
    async close() {},
  };
}

export async function redisBus(url: string): Promise<Bus> {
  const mod = await import("ioredis");
  const Redis = (mod.default ?? mod) as unknown as new (url: string) => import("ioredis").Redis;
  const pub = new Redis(url);
  const sub = new Redis(url);
  const subs = new Map<string, Set<Handler>>();
  sub.on("message", (channel: string, raw: string) => {
    for (const h of subs.get(channel) ?? []) h(channel, JSON.parse(raw));
  });

  const ttlSec = Math.ceil(PRESENCE_TTL_MS / 1000);
  const connKey = (userId: string) => `conns:${userId}`;

  /** Drop sessions from nodes that died without cleaning up, then count what's left. */
  async function pruneAndCount(userId: string): Promise<number> {
    const key = connKey(userId);
    const pipe = pub.multi();
    pipe.zremrangebyscore(key, "-inf", Date.now() - PRESENCE_TTL_MS);
    pipe.zcard(key);
    pipe.expire(key, ttlSec * 2);
    const res = await pipe.exec();
    return Number(res?.[1]?.[1] ?? 0);
  }

  return {
    async publish(channel, payload) {
      await pub.publish(channel, JSON.stringify(payload));
    },
    subscribe(channel, h) {
      if (!subs.has(channel)) {
        subs.set(channel, new Set());
        void sub.subscribe(channel);
      }
      subs.get(channel)!.add(h);
      return () => {
        const s = subs.get(channel);
        s?.delete(h);
        if (s && s.size === 0) {
          subs.delete(channel);
          void sub.unsubscribe(channel);
        }
      };
    },
    async getPresence(id) {
      const raw = await pub.get(`presence:${id}`);
      return raw ? (JSON.parse(raw) as Presence) : undefined;
    },
    async setPresence(id, p) {
      if (p) await pub.set(`presence:${id}`, JSON.stringify(p), "EX", ttlSec);
      else await pub.del(`presence:${id}`);
    },
    async addSession(userId, sessionId) {
      await pub.zadd(connKey(userId), Date.now(), sessionId);
      return pruneAndCount(userId);
    },
    async removeSession(userId, sessionId) {
      await pub.zrem(connKey(userId), sessionId);
      return pruneAndCount(userId);
    },
    async touchSession(userId, sessionId) {
      const pipe = pub.multi();
      pipe.zadd(connKey(userId), Date.now(), sessionId);
      // Keep presence alive for as long as a socket is actually held.
      pipe.expire(`presence:${userId}`, ttlSec);
      await pipe.exec();
      return pruneAndCount(userId);
    },
    countSessions(userId) {
      return pruneAndCount(userId);
    },
    async setIfChanged(key, value) {
      const prev = await pub.getset(`flag:${key}`, value);
      await pub.expire(`flag:${key}`, ttlSec * 4);
      return prev !== value;
    },
    async close() {
      await Promise.all([pub.quit(), sub.quit()]);
    },
  };
}

/** Internal frame: tells a user's live sockets to start following a conversation. Never forwarded to clients. */
export const subscribeHint = (bus: Bus, userIds: string[], conversationId: string) =>
  Promise.all(userIds.map((u) => bus.publish(channels.user(u), { type: "_subscribe", conversation_id: conversationId })));

export const channels = {
  user: (userId: string) => `user:${userId}`, // frames addressed to a single user (all their sockets)
  conversation: (id: string) => `conv:${id}`, // frames for everyone in a conversation
  presence: (userId: string) => `presence:${userId}`, // presence changes of this user
};
