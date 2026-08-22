/**
 * Bus = cross-node pub/sub + presence store. In-memory for single-node dev; Redis for clusters.
 */
import type { Presence } from "@buddylist/protocol";

export type Handler = (channel: string, payload: unknown) => void;

export interface Bus {
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, h: Handler): () => void;
  getPresence(userId: string): Promise<Presence | undefined>;
  setPresence(userId: string, p: Presence | undefined): Promise<void>;
  close(): Promise<void>;
}

export function memoryBus(): Bus {
  const subs = new Map<string, Set<Handler>>();
  const presence = new Map<string, Presence>();
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
      return presence.get(id);
    },
    async setPresence(id, p) {
      if (p) presence.set(id, p);
      else presence.delete(id);
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
      if (p) await pub.set(`presence:${id}`, JSON.stringify(p), "EX", 120);
      else await pub.del(`presence:${id}`);
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
