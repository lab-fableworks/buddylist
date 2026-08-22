/** Attachment REST routes (two-step upload, metadata, download, message linkage). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "./app.js";
import { badRequest, conflict, forbidden, notFound, HttpError } from "./errors.js";
import { issueToken, consumeToken } from "./storage.js";
import { MAX_ATTACHMENT_SIZE } from "./services/attachments.js";

const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
};

const CreateAttachment = z.object({
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(255).default("application/octet-stream"),
  size: z.number().int().nonnegative(),
});
const LinkAttachments = z.object({ attachment_ids: z.array(z.string().uuid()).min(1) });

/**
 * Types safe to render inline in the viewer's origin (FR-26: text, diffs, images, JSON, logs).
 * Everything else — including text/html and image/svg+xml, both of which can carry active
 * content — is forced to download so a malicious upload can never execute as HTML/script.
 */
function isInlineSafe(mime: string): boolean {
  if (mime === "image/svg+xml") return false;
  if (mime.startsWith("image/")) return true;
  if (mime === "application/pdf") return true;
  if (mime === "application/json") return true;
  if (mime.startsWith("text/") && mime !== "text/html") return true;
  return false;
}

function contentDisposition(filename: string, inline: boolean): string {
  const safe = filename.replace(/["\r\n]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `${inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

export function registerAttachmentRoutes(app: FastifyInstance, ctx: AppContext) {
  const { attachments, messages, db, storage } = ctx;

  // ---- create (step 1: reserve id + get an upload URL) ----
  app.post("/api/attachments", async (req, reply) => {
    const body = parse(CreateAttachment, req.body);
    if (body.size > MAX_ATTACHMENT_SIZE) throw badRequest(`file exceeds maximum size of ${MAX_ATTACHMENT_SIZE} bytes`);
    const row = await attachments.create(req.user.id, body);
    const token = issueToken(row.id);
    const expires_at = new Date(Date.now() + 15 * 60_000).toISOString();
    return reply.status(201).send({ id: row.id, upload_url: `/api/attachments/${row.id}/content?token=${token}`, expires_at });
  });

  // ---- metadata ----
  app.get("/api/attachments/:id", async (req) => {
    const { id } = req.params as { id: string };
    const row = await attachments.getById(id);
    if (!row || !(await attachments.canRead(req.user.id, id))) throw notFound("attachment");
    return { id: row.id, uploader_id: row.uploader_id, filename: row.filename, mime: row.mime, size: row.size, sha256: row.sha256, uploaded_at: row.uploaded_at, created_at: row.created_at };
  });

  // ---- download (step: bytes) ----
  app.get("/api/attachments/:id/content", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await attachments.getById(id);
    if (!row || !(await attachments.canRead(req.user.id, id))) throw notFound("attachment");
    if (!row.uploaded_at) throw conflict("attachment content has not been uploaded yet");
    const bytes = await storage.get(row.storage_key);
    reply
      .header("content-type", row.mime)
      .header("content-length", String(bytes.byteLength))
      .header("content-disposition", contentDisposition(row.filename, isInlineSafe(row.mime)))
      .header("x-content-type-options", "nosniff")
      .send(bytes);
  });

  // ---- linkage (messages.ts is out of scope; linking is a separate call from here) ----
  app.post("/api/messages/:id/attachments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { attachment_ids } = parse(LinkAttachments, req.body);
    const msg = await db.one<{ sender_id: string }>("SELECT sender_id FROM messages WHERE id=$1", [id]);
    if (!msg) throw notFound("message");
    if (msg.sender_id !== req.user.id) throw forbidden("only the sender can attach files to this message");
    const rows = await attachments.byIds(attachment_ids);
    if (rows.length !== attachment_ids.length) throw badRequest("one or more attachments do not exist");
    for (const r of rows) {
      if (r.uploader_id !== req.user.id) throw forbidden("you can only attach files you uploaded");
      if (!r.uploaded_at) throw badRequest(`attachment ${r.id} has not finished uploading`);
    }
    await attachments.linkToMessage(id, attachment_ids);
    return reply.status(201).send({ ok: true, attachments: rows });
  });
  app.get("/api/messages/:id/attachments", async (req) => {
    const { id } = req.params as { id: string };
    const msg = await db.one<{ conversation_id: string }>("SELECT conversation_id FROM messages WHERE id=$1", [id]);
    if (!msg) throw notFound("message");
    if (!(await messages.isMember(msg.conversation_id, req.user.id))) throw forbidden("not a member of this conversation");
    const map = await attachments.forMessages([id]);
    return map[id] ?? [];
  });

  // ---- upload (step 2: raw bytes) ----
  // Registered in its own encapsulated child context so the catch-all binary
  // content-type parser only applies to this one route; every other route
  // above (and everywhere else in the app) keeps Fastify's default JSON parsing.
  app.register(async (instance) => {
    instance.addContentTypeParser("*", { parseAs: "buffer" }, (_req, payload, done) => done(null, payload));
    // bodyLimit is set generously above MAX_ATTACHMENT_SIZE so Fastify's own body-too-large
    // rejection (which the app's shared error handler would turn into a 500, since it only
    // special-cases HttpError/Zod/Postgres errors) never fires; the size check below — which
    // throws a proper HttpError — is what actually enforces the 25MB cap on oversize bodies.
    instance.put(
      "/api/attachments/:id/content",
      { bodyLimit: MAX_ATTACHMENT_SIZE * 4 },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const { token } = req.query as { token?: string };
        if (!token) throw new HttpError(401, "unauthorized", "missing upload token");
        const tokenAttachmentId = consumeToken(token);
        if (!tokenAttachmentId || tokenAttachmentId !== id) throw new HttpError(401, "unauthorized", "invalid or expired upload token");
        const row = await attachments.getById(id);
        if (!row) throw notFound("attachment");
        if (row.uploaded_at) throw conflict("attachment already uploaded");
        const raw = req.body;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === "string" ? raw : []);
        if (buf.byteLength > MAX_ATTACHMENT_SIZE) throw badRequest(`file exceeds maximum size of ${MAX_ATTACHMENT_SIZE} bytes`);
        const put = await storage.put(row.storage_key, buf);
        const updated = await attachments.markUploaded(id, put);
        return reply.status(200).send({ id: updated.id, size: updated.size, sha256: updated.sha256, uploaded_at: updated.uploaded_at });
      },
    );
  });
}
