/**
 * Blob storage for attachments. Local disk by default (zero infra, like PGlite);
 * an S3/MinIO driver can be slotted in behind the same interface.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface PutResult {
  size: number;
  sha256: string;
}

export interface Storage {
  /** Opaque key for a new object. */
  newKey(attachmentId: string, filename: string): string;
  put(key: string, data: Buffer): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  readonly kind: string;
}

export async function openStorage(opts: { dir?: string } = {}): Promise<Storage> {
  const root = resolve(opts.dir ?? "./.storage");
  await mkdir(root, { recursive: true });
  const pathFor = (key: string) => {
    const full = resolve(root, key);
    // Defence in depth: never let a crafted key escape the storage root.
    if (full !== root && !full.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) throw new Error("invalid storage key");
    return full;
  };
  return {
    kind: "local",
    newKey(attachmentId, filename) {
      const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-64) || "file";
      return `${attachmentId.slice(0, 2)}/${attachmentId}-${safe}`;
    },
    async put(key, data) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
      return { size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
    },
    async get(key) {
      return readFile(pathFor(key));
    },
    async remove(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

/** Short-lived opaque token used to authorize a direct upload/download (stands in for an S3 presigned URL). */
const tokens = new Map<string, { attachmentId: string; expires: number }>();
export function issueToken(attachmentId: string, ttlMs = 15 * 60_000): string {
  const t = randomBytes(24).toString("base64url");
  tokens.set(t, { attachmentId, expires: Date.now() + ttlMs });
  return t;
}
export function consumeToken(token: string): string | undefined {
  const e = tokens.get(token);
  if (!e) return undefined;
  if (e.expires < Date.now()) {
    tokens.delete(token);
    return undefined;
  }
  return e.attachmentId;
}
export { join as joinKey };
