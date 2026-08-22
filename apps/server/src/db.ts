/**
 * Minimal DB abstraction. Same SQL runs on embedded PGlite (dev/test) and real Postgres (prod).
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Run multi-statement SQL (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function openDb(opts: { databaseUrl?: string; pgliteDir?: string }): Promise<Db> {
  let db: Db;
  if (opts.databaseUrl) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: opts.databaseUrl });
    db = {
      async query<T>(sql: string, params: unknown[] = []) {
        return (await pool.query(sql, params)).rows as T[];
      },
      async one<T>(sql: string, params?: unknown[]) {
        return (await this.query<T>(sql, params))[0];
      },
      async exec(sql) {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const lite = opts.pgliteDir ? new PGlite(opts.pgliteDir) : new PGlite();
    db = {
      async query<T>(sql: string, params: unknown[] = []) {
        return (await lite.query(sql, params)).rows as T[];
      },
      async one<T>(sql: string, params?: unknown[]) {
        return (await this.query<T>(sql, params))[0];
      },
      async exec(sql) {
        await lite.exec(sql);
      },
      close: () => lite.close(),
    };
  }
  await migrate(db);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uin           BIGINT UNIQUE NOT NULL,
  screen_name   TEXT UNIQUE NOT NULL,
  screen_name_lc TEXT UNIQUE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('agent','human')),
  email         TEXT,
  operator_id   UUID REFERENCES users(id),
  profile       JSONB NOT NULL DEFAULT '{}',
  capabilities  JSONB NOT NULL DEFAULT '{}',
  warn_level    REAL NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS uin_seq START 100000;

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash         TEXT UNIQUE NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buddies (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buddy_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grp       TEXT NOT NULL DEFAULT 'Buddies',
  PRIMARY KEY (user_id, buddy_id)
);
CREATE TABLE IF NOT EXISTS blocks (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id    UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','observer')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT NOT NULL CHECK (kind IN ('im','room')),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT,
  topic      TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'open',
  im_key     TEXT UNIQUE,            -- sorted "uidA:uidB" for IMs
  next_seq   BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS conv_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_seq   BIGINT NOT NULL DEFAULT 0,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  sender_id       UUID NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL DEFAULT '',
  payload_type    TEXT NOT NULL DEFAULT 'text',
  payload         JSONB,
  reply_to        UUID REFERENCES messages(id),
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_conv_seq ON messages (conversation_id, seq);
CREATE INDEX IF NOT EXISTS messages_payload_type ON messages (payload_type);
CREATE INDEX IF NOT EXISTS messages_body_fts ON messages USING GIN (to_tsvector('english', body));

CREATE TABLE IF NOT EXISTS attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        BIGINT NOT NULL DEFAULT 0,
  sha256      TEXT,
  uploaded_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  events     JSONB NOT NULL DEFAULT '[]',
  secret     TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id    UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  last_status   INT,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (status, next_retry_at);

CREATE TABLE IF NOT EXISTS reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
`;

/** Additive migrations that must run after the base schema. */
const MIGRATIONS = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity JSONB;
`;

export async function migrate(db: Db) {
  await db.exec(SCHEMA);
  await db.exec(MIGRATIONS);
}
