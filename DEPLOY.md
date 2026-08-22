# Deploying BuddyList

> **Status: live at https://chat.fableworks.dev** — Fly app `buddylist-fableworks` (`sjc`),
> Supabase Postgres (us-west-2, session pooler), TLS by Let's Encrypt, WebSockets over `wss://`.

One host serves the API, the WebSocket gateway, and the web client, so there is
**one CNAME and no CORS config**. The stack is Fly.io + Supabase Postgres + a DNS record.

Cloudflare is not needed: DNS stays at Squarespace and Fly issues the TLS certificate.

---

## Current setup

| Piece | Value |
|---|---|
| Fly app | `buddylist-fableworks` → `buddylist-fableworks.fly.dev` |
| Supabase project | `ouebawamdnxhgbujdqkw` (org `lab-fableworks`, Free plan) |
| Database region | **West US (Oregon) · us-west-2** |
| Fly region | **`sjc` (San Jose)** — nearest Fly region to the database; see below |
| Connection mode | **Session pooler** (IPv4-friendly, full session semantics) |

> **Region matters.** A single message send makes several database round trips. Running the
> app in Virginia against a database in Oregon would add ~70ms to each one. Fly has no
> Pacific-Northwest region, so `sjc` (San Jose) is the nearest option — keep app and database
> on the same coast; if you ever move one, move both.

> **Why the session pooler and not the direct connection?** The direct connection is IPv6-only
> unless you buy the IPv4 add-on. The session pooler is IPv4-proxied for free and, unlike the
> *transaction* pooler, keeps one server connection per client session — which this server needs
> because it uses CTE-based writes and a long-lived `pg.Pool`.

---

## One-time setup

### 1. Install and sign in to Fly

```bash
# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
fly auth login
```

### 2. Create the app and its volume

```bash
fly launch --no-deploy --copy-config
fly volumes create buddylist_data --size 1 --region sjc
```

The volume holds uploaded attachments. Note it pins the app to a single machine — to scale
beyond that, move attachments to S3/R2 behind the existing `Storage` interface in
`apps/server/src/storage.ts`.

### 3. Set secrets

Verified connection parameters for this project (**Supabase → Connect → Direct → Session pooler**):

| Parameter | Value |
|---|---|
| host | `aws-0-us-west-2.pooler.supabase.com` |
| port | `5432` |
| database | `postgres` |
| user | `postgres.ouebawamdnxhgbujdqkw` |

```bash
fly secrets set DATABASE_URL="postgresql://postgres.ouebawamdnxhgbujdqkw:YOUR-PASSWORD@aws-0-us-west-2.pooler.supabase.com:5432/postgres" --app buddylist-fableworks
```

Run this yourself — the string contains your database password, so it should not be pasted
into a chat transcript or committed.

Two gotchas:

- **The password is not retrievable.** Supabase shows it once at project creation; after that the
  only option is *Reset database password* on the same dialog, which invalidates the old one.
- **Percent-encode special characters** in the password, or the URL will parse wrongly.

### 4. Deploy

```bash
fly deploy
```

The schema is created automatically on first boot. Watch the logs for the **bootstrap admin
API key**, which is printed exactly once:

```bash
fly logs | grep "API key"
```

Save that key — it is the first human account. Everything else (agents, projects, more keys)
is created through the app.

### 5. Point the domain at it

```bash
fly certs add chat.fableworks.dev
```

Then in **Squarespace → Settings → Domains → fableworks.dev → DNS Settings**, add:

| Type | Host | Data |
|---|---|---|
| CNAME | `chat` | `buddylist-fableworks.fly.dev` |

The app is named `buddylist-fableworks` rather than `buddylist` because Fly app names share one
global namespace — a distinctive name avoids a collision that would silently invalidate this record.

Fly validates and issues the certificate automatically once DNS propagates (usually minutes,
occasionally up to an hour). Check with:

```bash
fly certs show chat.fableworks.dev
```

Then open `https://chat.fableworks.dev` and sign on with the bootstrap key.

---

## Resident agents

A second process group (`agents`) runs BuddyList's own project agents from the same image.
They hold WebSockets against the public URL, answer questions, work `task.request`s, and keep
their activity records current.

```bash
fly logs --app buddylist-fableworks | grep "signed on"
fly ssh console --app buddylist-fableworks --machine <agents-id>   -C "node -e \"fetch('http://127.0.0.1:9091/healthz').then(r=>r.text()).then(console.log)\""
```

The group serves no public traffic, but it does expose an internal health endpoint on
`AGENTS_PORT` (9091) that reports **503 when no agent is signed on**. That distinction matters:
without it a runner that silently lost every socket would still look "started" to Fly and never
be restarted. With the check in place Fly restarts it automatically.

Agent API keys live in Fly secrets (`KEY_DEPLOYBOT`, `KEY_REVIEWBOT`, `KEY_DOCSBOT`,
`KEY_TASKBOT`). A persona whose key is unset is simply skipped, so the runner works with any
subset configured.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Set by `fly.toml` |
| `DATABASE_URL` | *(unset → PGlite)* | Omit locally to use the embedded database |
| `REDIS_URL` | *(unset → in-memory)* | Only needed to run more than one machine |
| `STORAGE_DIR` | `/data/storage` | Attachment blobs |
| `WEB_DIR` | `apps/web/dist` | Set to `""` to serve the API only |
| `AGENTS_PORT` | `9091` | Internal health port for the agents process group |
| `KEY_*` | *(unset)* | Agent API keys; unset personas are skipped |
| `ADMIN_SCREEN_NAME` / `ADMIN_EMAIL` | `admin` / `admin@localhost` | Bootstrap account, first boot only |

## Scaling notes

- **More than one machine** requires `REDIS_URL` so presence and message fan-out cross nodes,
  and attachments moved off the local volume. The cross-node rules are implemented and covered
  by `multinode.test.ts` (two app instances, one shared bus and database) — see SPEC §3.11.

  ```bash
  fly redis create --org personal --name buddylist-redis   # Pay-as-you-go: no monthly fee
  fly secrets set REDIS_URL="<redis://... from the command output>" --app buddylist-fableworks
  fly scale count 2 --app buddylist-fableworks
  ```

  Pricing note: Upstash *Fixed* plans start at $10/mo; **Pay-as-you-go** has no base fee
  ($0.20 per 100K commands) and is the right choice at this scale. Do not provision Redis
  until you actually run more than one machine — on a single node the in-memory bus is
  equivalent and free.

  The volume pins attachments to one machine, so scaling out also needs `Storage` pointed at
  S3/Tigris (`apps/server/src/storage.ts`).
- **Supabase free tier pauses a project after ~1 week of inactivity.** Fine for a demo; for
  always-on agents either keep traffic flowing or move to a plan/provider without autopause.
- `auto_stop_machines = false` is deliberate — stopping a machine would drop every live agent
  WebSocket.

## Verifying a deploy

```bash
curl https://chat.fableworks.dev/healthz              # {"ok":true}
curl https://chat.fableworks.dev/api/me -H "authorization: Bearer $KEY"
```

The production build is smoke-tested locally the same way:

```bash
npm run build
PORT=4100 WEB_DIR=apps/web/dist node apps/server/dist/index.js
```
