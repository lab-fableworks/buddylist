import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { ClientFrame, type ServerFrame } from "@buddylist/protocol";
import type { AppContext } from "./app.js";
import { authenticate, bearer } from "./auth.js";
import { channels, PRESENCE_TTL_MS } from "./bus.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * WS gateway. One socket = one authenticated user session. Responsibilities:
 *  - presence: online on connect, offline when the last socket closes, idle after no heartbeat
 *  - fan-out: subscribes to user channel, every conversation channel, and buddies' presence channels
 *  - catch-up: `hello` with last_seq map replays missed messages per conversation
 */
export function registerWs(app: FastifyInstance, ctx: AppContext) {
  const { users, messages, bus } = ctx;
  const sessions = new Map<string, Set<WebSocket>>(); // userId -> sockets (this node)

  const send = (ws: WebSocket, frame: ServerFrame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const now = () => new Date().toISOString();

  app.get("/ws", { websocket: true }, async (socket, req) => {
    const key = bearer(req.headers.authorization) ?? (req.query as { key?: string }).key ?? req.headers["sec-websocket-protocol"]?.split(",")[0]?.trim();
    const auth = await authenticate(ctx.db, key);
    if (!auth) {
      send(socket, { type: "error", ts: now(), data: { code: "unauthorized", message: "invalid API key" } });
      return socket.close(4001, "unauthorized");
    }
    const user = (await users.byId(auth.id))!;
    const unsubs: Array<() => void> = [];
    let lastHeartbeat = Date.now();
    let idle = false;

    // --- register session & presence ---
    // Session ids are tracked on the bus, not just locally, so a second node holding the
    // same user keeps them online when this node's socket closes.
    const sessionId = randomUUID();
    const mine = sessions.get(user.id) ?? new Set();
    mine.add(socket);
    sessions.set(user.id, mine);
    const sessionCount = await bus.addSession(user.id, sessionId);
    if (sessionCount === 1 || (await users.presenceOf(user.id)).state === "offline") await users.setPresence(user, { state: "online" });
    await announceVisibility(user, await users.presenceOf(user.id));

    send(socket, { type: "welcome", ts: now(), data: { screen_name: user.screen_name, uin: Number(user.uin) } });

    // --- subscriptions ---
    const convSubs = new Map<string, () => void>();
    const subscribeConv = (id: string) => {
      if (convSubs.has(id)) return;
      convSubs.set(id, bus.subscribe(channels.conversation(id), (_c, f) => send(socket, f as ServerFrame)));
    };
    unsubs.push(
      bus.subscribe(channels.user(user.id), (_c, f) => {
        const frame = f as ServerFrame | { type: "_subscribe"; conversation_id: string };
        if (frame.type === "_subscribe") return subscribeConv(frame.conversation_id);
        send(socket, frame);
      }),
    );
    for (const c of await messages.inbox(user.id)) subscribeConv(c.id);
    // Safety net behind the _subscribe hints (e.g. membership changed on another node before Redis delivered).
    const rescan = setInterval(async () => {
      for (const c of await messages.inbox(user.id)) subscribeConv(c.id);
    }, 30_000);

    const presenceSubs = new Map<string, () => void>();
    const watchPresence = async () => {
      const buddies = await ctx.db.query<{ id: string }>(
        `SELECT buddy_id AS id FROM buddies WHERE user_id=$1
         UNION SELECT them.user_id FROM project_members me JOIN project_members them ON them.project_id=me.project_id WHERE me.user_id=$1 AND them.user_id<>$1`,
        [user.id],
      );
      for (const b of buddies) {
        if (presenceSubs.has(b.id)) continue;
        presenceSubs.set(
          b.id,
          bus.subscribe(channels.presence(b.id), (_c, p) => {
            const { screen_name, presence } = p as { screen_name: string; presence: { state: string } };
            send(socket, { type: "presence", ts: now(), data: { screen_name, presence: presence as never } });
          }),
        );
      }
    };
    await watchPresence();
    const rewatch = setInterval(watchPresence, 30_000);

    // --- inbound frames ---
    socket.on("message", async (raw) => {
      lastHeartbeat = Date.now();
      if (idle) {
        idle = false;
        await users.setPresence(user, { state: "online" });
      }
      let frame: ClientFrame;
      try {
        frame = ClientFrame.parse(JSON.parse(raw.toString()));
      } catch (e) {
        return send(socket, { type: "error", ts: now(), data: { code: "bad_frame", message: (e as Error).message } });
      }
      switch (frame.type) {
        case "ping":
          return send(socket, { type: "pong", ts: now() });
        case "hello": {
          for (const [convId, seq] of Object.entries(frame.last_seq)) {
            if (!(await messages.isMember(convId, user.id))) continue;
            subscribeConv(convId);
            for (const m of await messages.history(convId, user.id, { after: seq, limit: 200 }))
              send(socket, { type: "message", ts: m.ts, conversation_id: convId, seq: m.seq, data: m });
          }
          return;
        }
        case "presence.set":
          return users.setPresence(user, frame.data);
        case "typing": {
          if (!(await messages.isMember(frame.conversation_id, user.id))) return;
          return bus.publish(channels.conversation(frame.conversation_id), { type: "typing", ts: now(), conversation_id: frame.conversation_id, data: { screen_name: user.screen_name } } satisfies ServerFrame);
        }
        case "ack":
          if (await messages.isMember(frame.conversation_id, user.id)) await messages.markRead(frame.conversation_id, user.id, frame.seq);
          return;
      }
    });

    // --- liveness ---
    const liveness = setInterval(async () => {
      // Refresh first: presence carries a TTL, so a long-lived quiet socket would otherwise
      // let the key expire and the user would appear offline while still connected.
      await bus.touchSession(user.id, sessionId).catch(() => {});
      const silent = Date.now() - lastHeartbeat;
      if (silent > config.socketTimeoutMs * 3) return socket.terminate();
      if (!idle && silent > config.heartbeatIdleMs) {
        idle = true;
        const p = await users.presenceOf(user.id);
        if (p.state === "online") await users.setPresence(user, { state: "idle" });
      }
    }, Math.min(15_000, PRESENCE_TTL_MS / 4));

    socket.on("close", async () => {
      clearInterval(liveness);
      clearInterval(rescan);
      clearInterval(rewatch);
      unsubs.forEach((u) => u());
      convSubs.forEach((u) => u());
      presenceSubs.forEach((u) => u());
      mine.delete(socket);
      if (mine.size === 0) sessions.delete(user.id);
      const remaining = await bus.removeSession(user.id, sessionId).catch(() => 0);
      if (remaining === 0) {
        // Nobody, on any node, still holds this user.
        await users.setPresence(user, undefined).catch(() => {}); // server may be shutting down
        await ctx.activity.clear(user.id, user.screen_name).catch(() => {});
      }
      await announceVisibility(user, await users.presenceOf(user.id).catch(() => ({ state: "offline" as const }))).catch(() => {});
    });
  });

  /**
   * Emit buddy.signon / buddy.signoff to watchers when a user's *visibility* flips.
   *
   * The flag lives on the bus rather than in a per-node Map so that exactly one node emits
   * the transition — otherwise every node in the cluster would fire its own copy and clients
   * would hear the door sound once per machine.
   */
  async function announceVisibility(u: { id: string; screen_name: string }, presence: { state: string }) {
    const visible = presence.state !== "offline" && presence.state !== "invisible";
    if (!(await bus.setIfChanged(`vis:${u.id}`, visible ? "1" : "0"))) return;
    const frame: ServerFrame = { type: visible ? "buddy.signon" : "buddy.signoff", ts: now(), data: { screen_name: u.screen_name } };
    for (const w of await users.watchersOf(u.id)) await bus.publish(channels.user(w), frame);
  }

  // A presence change that isn't a connect/disconnect (going invisible, coming back) also
  // flips visibility, so route those through the same deduplicated announcement.
  users.setPresenceSink((userId, screenName, presence) => {
    void announceVisibility({ id: userId, screen_name: screenName }, presence).catch(() => {});
  });
}
