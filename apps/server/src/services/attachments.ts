/**
 * Attachments ("Direct Connect"): two-step upload, message linkage, download.
 *
 * Authorization model: a user may read an attachment if they uploaded it, or
 * if it is linked (via message_attachments) to a message in a conversation
 * they are a member of. `canRead` implements that as a single SQL query.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { Storage } from "../storage.js";

/** Presigned-upload style size cap (mirrors what a real S3 presign policy would enforce). */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB

export interface AttachmentRow {
  id: string;
  uploader_id: string;
  storage_key: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string | null;
  uploaded_at: string | null;
  created_at: string;
}

interface RawRow {
  id: string;
  uploader_id: string;
  storage_key: string;
  filename: string;
  mime: string;
  size: number | string;
  sha256: string | null;
  uploaded_at: string | Date | null;
  created_at: string | Date;
}

const iso = (d: string | Date | null) => (d == null ? null : new Date(d).toISOString());
const toRow = (r: RawRow): AttachmentRow => ({
  id: r.id,
  uploader_id: r.uploader_id,
  storage_key: r.storage_key,
  filename: r.filename,
  mime: r.mime,
  size: Number(r.size),
  sha256: r.sha256,
  uploaded_at: iso(r.uploaded_at as string | Date | null),
  created_at: iso(r.created_at as string | Date) as string,
});

export function attachmentsService(db: Db, storage: Storage) {
  /** Reserve a new attachment row + storage key before the bytes exist. */
  async function create(uploaderId: string, input: { filename: string; mime: string; size: number }): Promise<AttachmentRow> {
    const id = randomUUID();
    const key = storage.newKey(id, input.filename);
    const row = await db.one<RawRow>(
      `INSERT INTO attachments (id, uploader_id, storage_key, filename, mime, size) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, uploaderId, key, input.filename, input.mime, input.size],
    );
    return toRow(row!);
  }

  async function getById(id: string): Promise<AttachmentRow | undefined> {
    const row = await db.one<RawRow>("SELECT * FROM attachments WHERE id=$1", [id]);
    return row ? toRow(row) : undefined;
  }

  /** Attachment ids the given user is allowed to attach / read (fetched without an ownership filter — callers apply `canRead`). */
  async function byIds(ids: string[]): Promise<AttachmentRow[]> {
    if (ids.length === 0) return [];
    const rows = await db.query<RawRow>("SELECT * FROM attachments WHERE id = ANY($1::uuid[])", [ids]);
    return rows.map(toRow);
  }

  /** Record that the bytes for `id` have landed in storage. */
  async function markUploaded(id: string, put: { size: number; sha256: string }): Promise<AttachmentRow> {
    const row = await db.one<RawRow>("UPDATE attachments SET size=$2, sha256=$3, uploaded_at=now() WHERE id=$1 RETURNING *", [id, put.size, put.sha256]);
    return toRow(row!);
  }

  /**
   * True if `userId` may read attachment `attachmentId`: they uploaded it, or
   * it is linked to a message in a conversation they belong to. Single query.
   */
  async function canRead(userId: string, attachmentId: string): Promise<boolean> {
    const row = await db.one(
      `SELECT 1 FROM attachments a
        WHERE a.id = $1
          AND (
            a.uploader_id = $2
            OR EXISTS (
              SELECT 1 FROM message_attachments ma
                JOIN messages m ON m.id = ma.message_id
                JOIN conv_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
               WHERE ma.attachment_id = a.id
            )
          )`,
      [attachmentId, userId],
    );
    return !!row;
  }

  /** Link uploaded attachments to a persisted message. */
  async function linkToMessage(messageId: string, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    const values = attachmentIds.map((_, i) => `($1, $${i + 2})`).join(",");
    await db.query(`INSERT INTO message_attachments (message_id, attachment_id) VALUES ${values} ON CONFLICT DO NOTHING`, [messageId, ...attachmentIds]);
  }

  /** Attachments for a set of messages, keyed by message id. Single query (no N+1). */
  async function forMessages(messageIds: string[]): Promise<Record<string, AttachmentRow[]>> {
    const out: Record<string, AttachmentRow[]> = {};
    if (messageIds.length === 0) return out;
    const rows = await db.query<RawRow & { message_id: string }>(
      `SELECT ma.message_id AS message_id, a.* FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = ANY($1::uuid[])`,
      [messageIds],
    );
    for (const r of rows) {
      const { message_id, ...rest } = r;
      (out[message_id] ??= []).push(toRow(rest as RawRow));
    }
    return out;
  }

  return { create, getById, byIds, markUploaded, canRead, linkToMessage, forMessages };
}
export type AttachmentsService = ReturnType<typeof attachmentsService>;
