import type { Db } from "../db.js";
import type { Bus } from "../bus.js";
import { channels, subscribeHint } from "../bus.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validatePayload, type Message, type SendMessage, type ServerFrame } from "@buddylist/protocol";
import type { UsersService } from "./users.js";
import type { ProjectsService } from "./projects.js";
import type { WebhooksService } from "./webhooks.js";

interface MsgRow {
  id: string;
  conversation_id: string;
  seq: number | string;
  sender: string;
  body: string;
  payload_type: string;
  payload: unknown;
  reply_to: string | null;
  edited_at: string | Date | null;
  deleted_at: string | Date | null;
  ts: string | Date;
}
const iso = (d: string | Date | null) => (d == null ? null : new Date(d).toISOString());
export const toMessage = (r: MsgRow): Message => ({
  id: r.id,
  conversation_id: r.conversation_id,
  seq: Number(r.seq),
  sender: r.sender,
  body: r.deleted_at ? "" : r.body,
  payload_type: r.payload_type,
  payload: r.deleted_at ? null : r.payload,
  reply_to: r.reply_to,
  edited_at: iso(r.edited_at),
  deleted_at: iso(r.deleted_at),
  ts: iso(r.ts)!,
});

const SELECT = `SELECT m.*, u.screen_name AS sender FROM messages m JOIN users u ON u.id = m.sender_id`;

export function messagesService(db: Db, bus: Bus, users: UsersService, projects: ProjectsService, webhooks?: WebhooksService) {
  async function isMember(conversationId: string, userId: string) {
    return !!(await db.one("SELECT 1 FROM conv_members WHERE conversation_id=$1 AND user_id=$2", [conversationId, userId]));
  }
  async function memberIds(conversationId: string) {
    return (await db.query<{ user_id: string }>("SELECT user_id FROM conv_members WHERE conversation_id=$1", [conversationId])).map((r) => r.user_id);
  }

  /** Find-or-create the IM conversation between two users. */
  async function imConversation(aId: string, bId: string) {
    const key = [aId, bId].sort().join(":");
    let c = await db.one<{ id: string }>("SELECT id FROM conversations WHERE im_key=$1", [key]);
    if (!c) {
      c = (await db.one<{ id: string }>("INSERT INTO conversations (kind, im_key) VALUES ('im',$1) ON CONFLICT (im_key) DO UPDATE SET im_key = EXCLUDED.im_key RETURNING id", [key]))!;
      await db.query("INSERT INTO conv_members (conversation_id, user_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING", [c.id, aId, bId]);
      await subscribeHint(bus, [aId, bId], c.id);
    }
    return c.id;
  }

  async function canPost(conversationId: string, userId: string) {
    const c = await db.one<{ kind: string; project_id: string | null; locked: boolean }>(
      "SELECT kind, project_id, locked FROM conversations WHERE id=$1",
      [conversationId],
    );
    if (!c) throw notFound("conversation");
    if (!(await isMember(conversationId, userId))) throw forbidden("not a member of this conversation");
    if (c.project_id) {
      const role = await projects.roleOf(c.project_id, userId);
      if (role === "observer") throw forbidden("observers cannot post");
      // A locked room is an announcement board: everyone reads, only admins write.
      if (c.locked && role !== "admin" && role !== "owner") throw forbidden("this room is read-only");
    }
  }

  async function send(conversationId: string, senderId: string, input: SendMessage): Promise<Message> {
    await canPost(conversationId, senderId);
    const v = validatePayload(input.payload_type, input.payload);
    if (!v.ok) throw badRequest(`invalid payload: ${v.error}`);
    if (!input.body && input.payload_type === "text") throw badRequest("empty message");
    if (input.reply_to) {
      const parent = await db.one("SELECT 1 FROM messages WHERE id=$1 AND conversation_id=$2", [input.reply_to, conversationId]);
      if (!parent) throw badRequest("reply_to must be in the same conversation");
    }
    // Atomic per-conversation sequence assignment.
    const row = (await db.one<MsgRow>(
      `WITH s AS (UPDATE conversations SET next_seq = next_seq + 1 WHERE id = $1 RETURNING next_seq - 1 AS seq),
       ins AS (INSERT INTO messages (conversation_id, seq, sender_id, body, payload_type, payload, reply_to)
               SELECT $1, s.seq, $2, $3, $4, $5::jsonb, $6 FROM s RETURNING *)
       SELECT ins.*, u.screen_name AS sender FROM ins JOIN users u ON u.id = ins.sender_id`,
      [conversationId, senderId, input.body, input.payload_type, JSON.stringify(v.value), input.reply_to ?? null],
    ))!;
    const msg = toMessage(row);
    const ts = new Date().toISOString();
    await bus.publish(channels.conversation(conversationId), { type: "message", ts, conversation_id: conversationId, seq: msg.seq, data: msg } satisfies ServerFrame);

    // Outbound webhooks: notify every recipient (never the sender). Fire-and-forget —
    // emit() swallows its own errors so a bad webhook can never fail a message send.
    if (webhooks) {
      const kind = await db.one<{ kind: string }>("SELECT kind FROM conversations WHERE id=$1", [conversationId]);
      const event = kind?.kind === "im" ? "im.received" : "room.message";
      for (const recipient of await memberIds(conversationId)) {
        if (recipient === senderId) continue;
        void webhooks.emit(recipient, event, msg);
        if (msg.payload_type === "task.request") void webhooks.emit(recipient, "task.request", msg);
      }
    }
    // mentions
    for (const name of new Set([...msg.body.matchAll(/@([A-Za-z0-9_]{3,24})/g)].map((m) => m[1]))) {
      const u = await users.byScreenName(name);
      if (u && u.id !== senderId && (await isMember(conversationId, u.id)))
        await bus.publish(channels.user(u.id), { type: "mention", ts, conversation_id: conversationId, seq: msg.seq, data: { from: msg.sender } } satisfies ServerFrame);
    }
    return msg;
  }

  async function history(conversationId: string, userId: string, opts: { after?: number; before?: number; limit?: number }) {
    if (!(await isMember(conversationId, userId))) throw forbidden("not a member of this conversation");
    const limit = Math.min(opts.limit ?? 50, 200);
    const rows = await db.query<MsgRow>(
      `${SELECT} WHERE m.conversation_id=$1 AND ($2::bigint IS NULL OR m.seq > $2) AND ($3::bigint IS NULL OR m.seq < $3)
       ORDER BY m.seq ${opts.after != null ? "ASC" : "DESC"} LIMIT $4`,
      [conversationId, opts.after ?? null, opts.before ?? null, limit],
    );
    const msgs = rows.map(toMessage);
    return opts.after != null ? msgs : msgs.reverse();
  }

  async function byId(id: string) {
    const r = await db.one<MsgRow>(`${SELECT} WHERE m.id=$1`, [id]);
    if (!r) throw notFound("message");
    return r;
  }
  async function edit(id: string, userId: string, body: string) {
    const r = await byId(id);
    const sender = await users.byScreenName(r.sender);
    if (sender?.id !== userId) throw forbidden("only the sender can edit");
    const row = (await db.one<MsgRow>(`WITH u AS (UPDATE messages SET body=$2, edited_at=now() WHERE id=$1 RETURNING *) SELECT u.*, us.screen_name AS sender FROM u JOIN users us ON us.id = u.sender_id`, [id, body]))!;
    const msg = toMessage(row);
    await bus.publish(channels.conversation(msg.conversation_id), { type: "message.edit", ts: new Date().toISOString(), conversation_id: msg.conversation_id, seq: msg.seq, data: msg } satisfies ServerFrame);
    return msg;
  }
  async function remove(id: string, userId: string) {
    const r = await byId(id);
    const sender = await users.byScreenName(r.sender);
    if (sender?.id !== userId) throw forbidden("only the sender can delete");
    await db.query("UPDATE messages SET deleted_at=now() WHERE id=$1", [id]);
    await bus.publish(channels.conversation(r.conversation_id), { type: "message.delete", ts: new Date().toISOString(), conversation_id: r.conversation_id, seq: Number(r.seq), data: { id } } satisfies ServerFrame);
  }
  async function react(id: string, userId: string, emoji: string, on: boolean) {
    const r = await byId(id);
    if (!(await isMember(r.conversation_id, userId))) throw forbidden("not a member");
    if (on) await db.query("INSERT INTO reactions VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, userId, emoji]);
    else await db.query("DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3", [id, userId, emoji]);
  }
  async function markRead(conversationId: string, userId: string, seq: number) {
    await db.query("UPDATE conv_members SET last_read_seq = GREATEST(last_read_seq, $3) WHERE conversation_id=$1 AND user_id=$2", [conversationId, userId, seq]);
    const u = await users.byId(userId);
    if (u) await bus.publish(channels.conversation(conversationId), { type: "receipt", ts: new Date().toISOString(), conversation_id: conversationId, data: { screen_name: u.screen_name, seq } } satisfies ServerFrame);
  }
  /** Conversations a user belongs to, with unread counts. */
  async function inbox(userId: string) {
    return db.query<{ id: string; kind: string; name: string | null; project_id: string | null; peer: string | null; last_seq: number; last_read_seq: number }>(
      `SELECT c.id, c.kind, c.name, c.project_id, c.next_seq - 1 AS last_seq, cm.last_read_seq,
              (SELECT u.screen_name FROM conv_members o JOIN users u ON u.id = o.user_id WHERE o.conversation_id = c.id AND o.user_id <> $1 AND c.kind='im' LIMIT 1) AS peer
         FROM conv_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.user_id = $1 ORDER BY c.created_at`,
      [userId],
    );
  }
  async function search(userId: string, q: string, opts: { project?: string; payload_type?: string; limit?: number }) {
    const rows = await db.query<MsgRow>(
      `${SELECT} JOIN conv_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
       JOIN conversations c ON c.id = m.conversation_id LEFT JOIN projects p ON p.id = c.project_id
       WHERE m.deleted_at IS NULL AND to_tsvector('english', m.body) @@ plainto_tsquery('english', $2)
         AND ($3::text IS NULL OR p.slug = $3) AND ($4::text IS NULL OR m.payload_type = $4)
       ORDER BY m.ts DESC LIMIT $5`,
      [userId, q, opts.project ?? null, opts.payload_type ?? null, Math.min(opts.limit ?? 50, 200)],
    );
    return rows.map(toMessage);
  }

  return { imConversation, isMember, memberIds, send, history, edit, remove, react, markRead, inbox, search };
}
export type MessagesService = ReturnType<typeof messagesService>;
