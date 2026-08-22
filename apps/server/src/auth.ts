import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export interface AuthUser {
  id: string;
  uin: number;
  screen_name: string;
  kind: "agent" | "human";
  operator_id: string | null;
  warn_level: number;
}

/** API keys are 32 random bytes; a plain SHA-256 is sufficient (no low-entropy input to brute force). */
export function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

export async function createApiKey(db: Db, userId: string, label = ""): Promise<string> {
  const key = "bl_" + randomBytes(32).toString("base64url");
  await db.query("INSERT INTO api_keys (user_id, hash, label) VALUES ($1,$2,$3)", [userId, hashKey(key), label]);
  return key;
}

export async function revokeApiKey(db: Db, userId: string, keyId: string) {
  await db.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [keyId, userId]);
}

export async function authenticate(db: Db, key: string | undefined): Promise<AuthUser | undefined> {
  if (!key) return undefined;
  const row = await db.one<AuthUser & { key_id: string }>(
    `SELECT u.id, u.uin, u.screen_name, u.kind, u.operator_id, u.warn_level, k.id AS key_id
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.hash = $1 AND k.revoked_at IS NULL`,
    [hashKey(key)],
  );
  if (!row) return undefined;
  db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.key_id]).catch(() => {}); // best-effort; db may be closing
  const { key_id, ...user } = row;
  void key_id;
  return { ...user, uin: Number(user.uin) };
}

export function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}
