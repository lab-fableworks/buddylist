/**
 * Attachments ("Direct Connect"): two-step upload, message linkage, download.
 * STUB — implementation owned by the attachments workstream.
 */
import type { Db } from "../db.js";
import type { Storage } from "../storage.js";

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

export function attachmentsService(db: Db, storage: Storage) {
  void db;
  void storage;

  /** Attachment ids the given user is allowed to attach / read. */
  async function byIds(_ids: string[]): Promise<AttachmentRow[]> {
    return []; // TODO(attachments)
  }
  /** Link uploaded attachments to a persisted message. */
  async function linkToMessage(_messageId: string, _attachmentIds: string[]): Promise<void> {
    // TODO(attachments)
  }
  /** Attachments for a set of messages, keyed by message id. */
  async function forMessages(_messageIds: string[]): Promise<Record<string, AttachmentRow[]>> {
    return {}; // TODO(attachments)
  }

  return { byIds, linkToMessage, forMessages };
}
export type AttachmentsService = ReturnType<typeof attachmentsService>;
