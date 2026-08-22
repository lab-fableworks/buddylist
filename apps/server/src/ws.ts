import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { ClientFrame, type ServerFrame } from "@buddylist/protocol";
import type { AppContext } from "./app.js";
import { authenticate, bearer } from "./auth.js";
import { channels } from "./bus.js";
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
    const mine = sessions.get(user.id) ?? new Set();
    const firstSocket = mine.size === 0;
    mine.add(socket);
    sessions.set(user.id, mine);
    if (firstSocket || (await users.presenceOf(user.id)).state === "offline") await users.setPresence(user, { state: "online" });

    send(socket, { type: "welcome", ts: now(), data: { screen_name: user.screen_name, uin: Number(user.uin) } });

    // --- subscriptions ---
    unsubs.push(bus.subscribe(channels.user(user.id), (_c, f) => send(socket, f as ServerFrame)));
    const convSubs = new Map<string, () => void>();
    const subscribeConv = (id: string) => {
      if (convSubs.has(id)) return;
      convSubs.set(id, bus.subscribe(channels.conversation(id), (_c, f) => send(socket, f as ServerFrame)));
    };
    for (const c of await messages.inbox(user.id)) subscribeConv(c.id);
    // Pick up conversations created after connect (new IMs / room joins) by re-scanning lazily on any user-channel traffic and every 30s.
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
      const silent = Date.now() - lastHeartbeat;
      if (silent > config.socketTimeoutMs * 3) return socket.terminate();
      if (!idle && silent > config.heartbeatIdleMs) {
        idle = true;
        const p = await users.presenceOf(user.id);
        if (p.state === "online") await users.setPresence(user, { state: "idle" });
      }
    }, 15_000);

    socket.on("close", async () => {
      clearInterval(liveness);
      clearInterval(rescan);
      clearInterval(rewatch);
      unsubs.forEach((u) => u());
      convSubs.forEach((u) => u());
      presenceSubs.forEach((u) => u());
      mine.delete(socket);
      if (mine.size === 0) {
        sessions.delete(user.id);
        await users.setPresence(user, undefined);
      }
    });
  });

  // buddy.signon / signoff derived from presence transitions for watchers
  // (clients can also derive this from presence frames; kept for the door sounds)
  const lastState = new Map<string, string>();
  bus.subscribe("presence-any", () => {});
  const origSet = users.setPresence;
  users.setPresence = async (u, p) => {
    await origSet(u, p);
    const prev = lastState.get(u.id) ?? "offline";
    const next = !p || p.state === "invisible" ? "offline" : p.state;
    lastState.set(u.id, next);
    if ((prev === "offline") !== (next === "offline")) {
      const frame: ServerFrame = { type: next === "offline" ? "buddy.signoff" : "buddy.signon", ts: now(), data: { screen_name: u.screen_name } };
      for (const w of await users.watchersOf(u.id)) await bus.publish(channels.user(w), frame);
    }
  };
}
