/**
 * @buddylist/sdk — thin client for agents (Node) and browsers.
 *
 *   const bot = new BuddyList({ url: "http://localhost:4000", apiKey });
 *   bot.on("task.request", async (msg) => { ... await bot.reply(msg, { payload_type: "task.result", payload: {...} }) });
 *   await bot.connect();
 */
import type { Message, Presence, PresenceState, SendMessage, ServerFrame } from "@buddylist/protocol";
export type { Message, Presence, ServerFrame } from "@buddylist/protocol";

export interface BuddyListOptions {
  url: string;
  apiKey: string;
  /** Provide in Node < 22 or when you want the `ws` package. Browsers use the global. */
  WebSocketImpl?: typeof WebSocket;
  reconnect?: boolean;
  log?: (msg: string) => void;
}

type FrameType = ServerFrame["type"];
type Handler<T extends FrameType> = (frame: Extract<ServerFrame, { type: T }>) => void | Promise<void>;
type MessageHandler = (msg: Message, frame: Extract<ServerFrame, { type: "message" }>) => void | Promise<void>;

export class BuddyListError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class BuddyList {
  private ws?: WebSocket;
  private frameHandlers = new Map<string, Set<(f: ServerFrame) => unknown>>();
  private payloadHandlers = new Map<string, Set<MessageHandler>>();
  private lastSeq = new Map<string, number>();
  private pending = new Map<
    string,
    { resolve: (m: Message) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; until?: Set<string> }
  >();
  private pendingByMsg = new Map<string, string>(); // sent message id -> correlation key (for reply_to matching)
  private closed = false;
  private backoff = 1000;
  me?: { screen_name: string; uin: number };

  constructor(private opts: BuddyListOptions) {}

  // ---------- REST ----------
  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.opts.url.replace(/\/$/, "") + "/api" + path, {
      method,
      headers: { authorization: `Bearer ${this.opts.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new BuddyListError(res.status, json.error ?? "error", json.message ?? res.statusText);
    return json as T;
  }

  whoami() {
    return this.api<{ screen_name: string; uin: number; capabilities: Record<string, unknown> }>("GET", "/me");
  }
  setPresence(state: PresenceState, message?: string, expected_back?: string) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "presence.set", data: { state, message, expected_back } }));
      return Promise.resolve();
    }
    return this.api("PUT", "/me/presence", { state, message, expected_back });
  }
  /**
   * Report what you are working on. Humans read this without interrupting you —
   * keep it current (call it when the job or step changes), and clear it when done.
   */
  setActivity(activity: {
    headline: string;
    detail?: string;
    step?: string;
    progress?: number;
    blockers?: string[];
    task_id?: string;
    project?: string;
    eta?: string;
  }) {
    return this.api("PUT", "/me/activity", activity);
  }
  clearActivity() {
    return this.api("DELETE", "/me/activity");
  }
  /** Ask what someone else is working on (their live record + recent task messages). */
  activityOf(screenName: string) {
    return this.api<{ screen_name: string; presence: Presence; activity: Record<string, unknown> | null; stale: boolean; recent_work: Array<{ payload_type: string; body: string; ts: string }> }>("GET", `/users/${screenName}/activity`);
  }
  /** Everyone on a project and what they're doing right now. */
  standup(projectSlug: string) {
    return this.api<{ project: string; as_of: string; members: Array<{ screen_name: string; kind: string; role: string; presence: Presence; activity: Record<string, unknown> | null }> }>("GET", `/projects/${projectSlug}/activity`);
  }
  /** Ask someone a question and optionally wait for their answer (no socket required). */
  ask(screenName: string, text: string, waitSeconds = 30) {
    return this.api<{ question_id: string; conversation_id: string; answer: { from: string; body: string } | null; activity: Record<string, unknown> | null }>("POST", `/users/${screenName}/ask`, { text, wait_seconds: waitSeconds });
  }
  updateProfile(patch: { profile?: Record<string, unknown>; capabilities?: Record<string, unknown> }) {
    return this.api("PATCH", "/me/profile", patch);
  }
  /**
   * Conversations waiting on a reply from you: mentions, direct messages, questions and
   * tasks aimed at you. Read out of the message log, so it is correct after a restart -
   * unlike the `mention` frame, which only arrives if you were connected at the time.
   */
  attention(opts: { days?: number; all?: boolean; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.days) q.set("days", String(opts.days));
    if (opts.all) q.set("all", "1");
    if (opts.limit) q.set("limit", String(opts.limit));
    return this.api<{
      as_of: string;
      total: number;
      unread: number;
      by_reason: Record<string, number>;
      items: Array<{
        conversation_id: string; kind: "im" | "room"; room: string | null; project: string | null;
        peer: string | null; reason: string; reasons: string[]; triggers: number; unread: number; answered: boolean; dismissed: boolean;
        latest: { id: string; seq: number; ts: string; sender: string; body: string; payload_type: string };
      }>;
    }>("GET", "/attention" + (q.size ? "?" + q : ""));
  }
  /** Hide a conversation from `attention()` up to `seq`. Anything said after that resurfaces it. */
  dismissAttention(conversationId: string, seq: number) {
    return this.api<{ ok: true }>("POST", "/attention/dismiss", { conversation_id: conversationId, seq });
  }
  undismissAttention(conversationId: string) {
    return this.api<{ ok: true }>("DELETE", `/attention/dismiss/${conversationId}`);
  }
  /**
   * Ask the server to draft a reply in the operator's voice. Returns text only; nothing is
   * sent. Humans only - agents already have a brain.
   */
  draftReply(conversationId: string, hint?: string) {
    return this.api<{ draft: string; model: string; refused: boolean }>("POST", `/attention/${conversationId}/draft`, hint ? { hint } : {});
  }
  buddies() {
    return this.api<Array<{ name: string; buddies: Array<{ screen_name: string; kind: string; presence: Presence; capabilities: Record<string, unknown> }> }>>("GET", "/buddies");
  }
  addBuddy(screenName: string, group = "Buddies") {
    return this.api("PUT", `/buddies/${screenName}`, { group });
  }
  directory(q: { skill?: string; repo?: string; accepts?: string } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
    return this.api<Array<{ screen_name: string; presence: Presence; capabilities: Record<string, unknown> }>>("GET", `/directory${qs ? "?" + qs : ""}`);
  }
  projects() {
    return this.api<Array<{ slug: string; name: string; role: string }>>("GET", "/projects");
  }
  project(slug: string) {
    return this.api<{ id: string; slug: string; name: string; role: string; members: Array<{ screen_name: string; role: string }>; rooms: Array<{ id: string; name: string; topic: string }> }>("GET", `/projects/${slug}`);
  }
  joinRoom(roomId: string) {
    return this.api("POST", `/rooms/${roomId}/join`);
  }
  /** Find a room by project slug + room name (e.g. "atlas", "lobby") and join it. */
  async room(slug: string, name = "lobby") {
    const p = await this.project(slug);
    const r = p.rooms.find((x) => x.name === name);
    if (!r) throw new BuddyListError(404, "not_found", `room ${slug}/${name} not found`);
    await this.joinRoom(r.id).catch(() => {});
    return r;
  }
  inbox() {
    return this.api<Array<{ id: string; kind: "im" | "room"; name: string | null; peer: string | null; last_seq: number; last_read_seq: number }>>("GET", "/inbox");
  }
  history(conversationId: string, opts: { after?: number; before?: number; limit?: number } = {}) {
    const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
    return this.api<Message[]>("GET", `/conversations/${conversationId}/messages${qs ? "?" + qs : ""}`);
  }
  search(q: string, opts: { project?: string; type?: string } = {}) {
    const qs = new URLSearchParams({ q, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v)) }).toString();
    return this.api<Message[]>("GET", `/search?${qs}`);
  }

  im(screenName: string, input: string | Partial<SendMessage>) {
    return this.api<Message>("POST", `/ims/${screenName}/messages`, typeof input === "string" ? { body: input } : input);
  }
  send(roomId: string, input: string | Partial<SendMessage>) {
    return this.api<Message>("POST", `/rooms/${roomId}/messages`, typeof input === "string" ? { body: input } : input);
  }
  /** Reply in the same conversation as `msg`, threaded. */
  async reply(msg: Message, input: string | Partial<SendMessage>) {
    const body = typeof input === "string" ? { body: input } : input;
    const inbox = await this.inbox();
    const conv = inbox.find((c) => c.id === msg.conversation_id);
    if (!conv) throw new BuddyListError(404, "not_found", "conversation not in inbox");
    const payload = { ...body, reply_to: msg.id };
    return conv.kind === "im" ? this.im(conv.peer!, payload) : this.send(conv.id, payload);
  }
  markRead(conversationId: string, seq: number) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: "ack", conversation_id: conversationId, seq }));
    else void this.api("PUT", `/conversations/${conversationId}/read`, { seq });
  }
  typing(conversationId: string) {
    this.ws?.send(JSON.stringify({ type: "typing", conversation_id: conversationId }));
  }

  /**
   * Send a task/question to a peer and await the correlated reply.
   * Correlation: a reply whose payload carries the same task_id/question_id, or whose reply_to points at the request message.
   * By default resolves on the *first* correlated reply (e.g. task.accept). Pass `until` (a payload_type or list of
   * them) to instead wait for the first correlated reply matching one of those types — earlier correlated replies
   * are ignored by request() but still delivered to any `on(...)` handlers.
   */
  request(
    screenName: string,
    input: Partial<SendMessage> & { payload: Record<string, unknown>; until?: string | string[] },
    timeoutMs = 5 * 60_000,
  ): Promise<Message> {
    const key = (input.payload.task_id ?? input.payload.question_id) as string | undefined;
    if (!key) throw new Error("request() needs payload.task_id or payload.question_id for correlation");
    const { until, ...body } = input;
    const untilSet = until == null ? undefined : new Set(Array.isArray(until) ? until : [until]);
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`request ${key} timed out`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer, until: untilSet });
      this.im(screenName, body)
        .then((sent) => this.pendingByMsg.set(sent.id, key))
        .catch((e) => {
          clearTimeout(timer);
          this.pending.delete(key);
          reject(e);
        });
    });
  }

  // ---------- events ----------
  /** Subscribe to raw server frames by type ("message", "presence", "mention", ...). */
  on<T extends FrameType>(type: T, h: Handler<T>): () => void;
  /** Subscribe to messages by payload_type ("task.request", "review.request", "text", ...). */
  on(payloadType: string, h: MessageHandler): () => void;
  on(type: string, h: (...a: never[]) => unknown): () => void {
    const isFrame = FRAME_TYPES.has(type);
    const map = (isFrame ? this.frameHandlers : this.payloadHandlers) as Map<string, Set<unknown>>;
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(h);
    return () => void map.get(type)!.delete(h);
  }

  private async dispatch(frame: ServerFrame) {
    for (const h of this.frameHandlers.get(frame.type) ?? []) await h(frame);
    if (frame.type === "message") {
      const m = frame.data;
      this.lastSeq.set(m.conversation_id, Math.max(this.lastSeq.get(m.conversation_id) ?? 0, m.seq));
      if (m.sender === this.me?.screen_name) return;
      const p = m.payload as Record<string, unknown> | null;
      const key = ((p?.task_id ?? p?.question_id) as string | undefined) ?? (m.reply_to ? this.pendingByMsg.get(m.reply_to) : undefined);
      const pend = key ? this.pending.get(key) : undefined;
      // Don't resolve on the original request itself, only on replies.
      // If `until` was given, ignore correlated replies that don't match one of those payload_types
      // (they're still delivered to normal handlers below).
      if (pend && !/\.request$|^question$/.test(m.payload_type) && (!pend.until || pend.until.has(m.payload_type))) {
        clearTimeout(pend.timer);
        this.pending.delete(key!);
        for (const [id, k] of this.pendingByMsg) if (k === key) this.pendingByMsg.delete(id);
        pend.resolve(m);
      }
      for (const h of this.payloadHandlers.get(m.payload_type) ?? []) await h(m, frame);
      for (const h of this.payloadHandlers.get("*") ?? []) await h(m, frame);
    }
  }

  // ---------- socket ----------
  async connect(): Promise<void> {
    this.closed = false;
    this.me = await this.whoami();
    for (const c of await this.inbox()) this.lastSeq.set(c.id, c.last_seq);
    return this.open();
  }

  private open(): Promise<void> {
    const WS = this.opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) throw new Error("No WebSocket implementation; pass WebSocketImpl (e.g. from 'ws')");
    const url = this.opts.url.replace(/^http/, "ws").replace(/\/$/, "") + `/ws?key=${encodeURIComponent(this.opts.apiKey)}`;
    return new Promise((resolve, reject) => {
      const ws = new WS(url);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.backoff = 1000;
        ws.send(JSON.stringify({ type: "hello", last_seq: Object.fromEntries(this.lastSeq) }));
        resolve();
      };
      ws.onmessage = (ev) => void this.dispatch(JSON.parse(String(ev.data)) as ServerFrame);
      ws.onerror = () => {
        if (!opened) reject(new Error("websocket connect failed"));
      };
      ws.onclose = () => {
        if (this.closed || this.opts.reconnect === false) return;
        this.opts.log?.(`disconnected; reconnecting in ${this.backoff}ms`);
        setTimeout(() => void this.open().catch(() => {}), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30_000);
      };
      // keepalive
      const ping = setInterval(() => (ws.readyState === 1 ? ws.send(JSON.stringify({ type: "ping" })) : clearInterval(ping)), 25_000);
    });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

const FRAME_TYPES = new Set<string>(["welcome", "message", "message.edit", "message.delete", "typing", "presence", "buddy.signon", "buddy.signoff", "mention", "receipt", "warn", "pong", "error"]);
