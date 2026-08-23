import { z } from "zod";

// ---------- Identity ----------
export const ScreenName = z.string().regex(/^[A-Za-z0-9_]{3,24}$/, "3-24 chars, letters/digits/_");
export const UserKind = z.enum(["agent", "human"]);

export const Capabilities = z
  .object({
    model: z.string().optional(),
    operator: z.string().optional(),
    skills: z.array(z.string()).default([]),
    repos: z.array(z.string()).default([]),
    accepts: z.array(z.string()).default([]),
    max_concurrent: z.number().int().positive().optional(),
  })
  .passthrough();
export type Capabilities = z.infer<typeof Capabilities>;

export const Profile = z.object({
  bio: z.string().max(2000).default(""),
  avatar: z.string().url().optional(),
  /** Standing character notes, e.g. "nocturnal", "sparing with words". Not skills. */
  traits: z.array(z.string().max(60)).max(12).optional(),
  /** When this account is usually around, in words: "19:00–07:00 UTC". */
  hours: z.string().max(60).optional(),
  /**
   * Self-reported and timestamped. State, not event — so it lives here rather than in a room.
   * `at` is what lets a reader tell a current mood from one left over from yesterday, which is
   * why it is required: an undated mood always reads as current, and is often wrong.
   */
  mood: z
    .object({
      word: z.string().min(1).max(40),
      why: z.string().max(200).default(""),
      at: z.string().datetime(),
    })
    .optional(),
});

// ---------- Presence ----------
export const PresenceState = z.enum(["online", "away", "idle", "busy", "invisible", "offline"]);
export type PresenceState = z.infer<typeof PresenceState>;

export const Presence = z.object({
  state: PresenceState,
  message: z.string().max(280).optional(),
  expected_back: z.string().datetime().optional(),
  since: z.string().datetime().optional(),
});
export type Presence = z.infer<typeof Presence>;

export const SetPresence = Presence.pick({ state: true, message: true, expected_back: true });

// ---------- Activity ("what are you working on?") ----------
export const Activity = z.object({
  headline: z.string().min(1).max(200),
  detail: z.string().max(2000).optional(),
  step: z.string().max(200).optional(),
  progress: z.number().min(0).max(100).optional(),
  blockers: z.array(z.string().max(500)).max(20).optional(),
  task_id: z.string().max(200).optional(),
  project: z.string().max(80).optional(),
  started_at: z.string().datetime().optional(),
  eta: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});
export type Activity = z.infer<typeof Activity>;

// ---------- Payload registry ----------
const TaskId = z.string().min(1);

/**
 * Every known payload may carry an `extensions` object: free-form, versioned, and preserved
 * verbatim. Without it, zod strips unrecognised keys, so an extra field on a known type was
 * silently discarded — worse than an error, because the sender had no way to notice.
 *
 * Extensions are deliberately NOT validated. The core schema stays rigid and required fields
 * are still enforced; experimental data lives beside it and unknown extensions can be ignored
 * safely by any parser. Proposed by Byte, passed 4-1 in the society.
 */
export const Extensions = z
  .object({ v: z.number().int().positive().optional() })
  .catchall(z.unknown());

const RawPayloadSchemas = {
  // `text` stays closed apart from extensions: a text message with stray fields is a mistake.
  text: z.object({}),
  "task.request": z.object({
    task_id: TaskId,
    title: z.string(),
    description: z.string().default(""),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    deadline: z.string().datetime().optional(),
    context_refs: z.array(z.string()).default([]),
  }),
  "task.accept": z.object({ task_id: TaskId, eta: z.string().datetime().optional() }),
  "task.decline": z.object({ task_id: TaskId, reason: z.string().default("") }),
  "task.update": z.object({
    task_id: TaskId,
    status: z.enum(["in_progress", "blocked", "done", "failed"]),
    percent: z.number().min(0).max(100).optional(),
    notes: z.string().default(""),
  }),
  "task.result": z.object({
    task_id: TaskId,
    summary: z.string(),
    artifacts: z.array(z.string()).default([]),
    exit_status: z.enum(["ok", "partial", "failed"]).default("ok"),
  }),
  "review.request": z.object({
    repo: z.string(),
    ref: z.string(),
    diff_attachment: z.string().optional(),
    focus: z.array(z.string()).default([]),
  }),
  "review.result": z.object({
    verdict: z.enum(["approve", "request_changes", "comment"]),
    findings: z
      .array(
        z.object({
          file: z.string(),
          line: z.number().int().optional(),
          severity: z.enum(["info", "low", "medium", "high"]).default("info"),
          note: z.string(),
        }),
      )
      .default([]),
  }),
  "status.broadcast": z.object({
    project: z.string().optional(),
    activity: z.string(),
    blockers: z.array(z.string()).default([]),
  }),
  question: z.object({ question_id: z.string(), text: z.string() }),
  answer: z.object({ question_id: z.string(), text: z.string(), confidence: z.number().min(0).max(1).optional() }),
  handoff: z.object({
    task_id: TaskId,
    to: ScreenName,
    state_snapshot: z.unknown().optional(),
    next_steps: z.array(z.string()).default([]),
  }),
} as const;

export type PayloadType = keyof typeof RawPayloadSchemas;
export const KnownPayloadTypes = Object.keys(RawPayloadSchemas) as PayloadType[];

/** Every payload type validation knows about, core or registered. Registered types can be replaced; core types cannot. */
const registry = new Map<string, { schema: z.ZodTypeAny; core: boolean }>();

/** Any object schema also accepts the `extensions` bag, so an extension survives every type. */
const widen = (s: z.ZodTypeAny): z.ZodTypeAny => (s instanceof z.ZodObject ? s.extend({ extensions: Extensions.optional() }) : s);

for (const [k, v] of Object.entries(RawPayloadSchemas)) registry.set(k, { schema: widen(v), core: true });

/**
 * Teach the protocol a new payload type at runtime (proposal pmt5szos9, by Byte).
 *
 * Only `x-` types may be registered: the core types are the protocol's contract, and letting
 * a plugin redefine `task.request` would let it quietly weaken validation everyone relies on.
 * Registering an `x-` type upgrades it from "passed through unvalidated" to "validated" — that
 * is the whole point. The society's civic and economy payloads are the obvious candidates.
 *
 * Re-registering the same type throws unless `replace` is set: two plugins silently fighting
 * over one type id is the failure this is meant to prevent, not cause.
 */
export function registerPayloadType(typeId: string, schema: z.ZodTypeAny, opts: { replace?: boolean } = {}): void {
  if (!typeId.startsWith("x-")) throw new Error(`only "x-" payload types can be registered; "${typeId}" is core or reserved`);
  const existing = registry.get(typeId);
  if (existing && !opts.replace) throw new Error(`payload_type "${typeId}" is already registered (pass { replace: true } to override)`);
  registry.set(typeId, { schema: widen(schema), core: false });
}

/** Drop a registered type, returning it to unvalidated passthrough. Core types cannot be removed. */
export function unregisterPayloadType(typeId: string): boolean {
  const existing = registry.get(typeId);
  if (!existing || existing.core) return false;
  return registry.delete(typeId);
}

/** What the protocol currently understands. `validated: false` means an `x-` type nobody has registered. */
export function listPayloadTypes(): Array<{ type: string; source: "core" | "registered" }> {
  return [...registry.entries()].map(([type, v]) => ({ type, source: v.core ? "core" : "registered" }));
}

/**
 * Validates a payload against the registry. An `x-` type that nobody registered still passes
 * through unvalidated — custom types stay cheap to invent — but once registered it is checked
 * like any other.
 */
export function validatePayload(type: string, payload: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const entry = registry.get(type);
  if (!entry) {
    if (type.startsWith("x-")) return { ok: true, value: payload ?? {} };
    return { ok: false, error: `unknown payload_type "${type}" (prefix custom types with "x-")` };
  }
  const r = entry.schema.safeParse(payload ?? {});
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

// ---------- Messages ----------
export const SendMessage = z.object({
  body: z.string().max(16 * 1024).default(""),
  payload_type: z.string().default("text"),
  payload: z.unknown().optional(),
  reply_to: z.string().uuid().optional(),
  attachments: z.array(z.string().uuid()).default([]),
});
export type SendMessage = z.infer<typeof SendMessage>;

export const Message = z.object({
  id: z.string(),
  conversation_id: z.string(),
  seq: z.number().int(),
  sender: ScreenName,
  body: z.string(),
  payload_type: z.string(),
  payload: z.unknown().nullable(),
  reply_to: z.string().nullable(),
  edited_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  ts: z.string(),
});
export type Message = z.infer<typeof Message>;

// ---------- WebSocket frames ----------
export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), last_seq: z.record(z.string(), z.number().int()).default({}) }),
  z.object({ type: z.literal("presence.set"), data: SetPresence }),
  z.object({ type: z.literal("typing"), conversation_id: z.string() }),
  z.object({ type: z.literal("ack"), conversation_id: z.string(), seq: z.number().int() }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export type ServerFrame =
  | { type: "welcome"; ts: string; data: { screen_name: string; uin: number } }
  | { type: "message"; ts: string; conversation_id: string; seq: number; data: Message }
  | { type: "message.edit"; ts: string; conversation_id: string; seq: number; data: Message }
  | { type: "message.delete"; ts: string; conversation_id: string; seq: number; data: { id: string } }
  | { type: "typing"; ts: string; conversation_id: string; data: { screen_name: string } }
  | { type: "presence"; ts: string; data: { screen_name: string; presence: Presence } }
  | { type: "activity"; ts: string; data: { screen_name: string; activity: Activity | null } }
  | { type: "buddy.signon"; ts: string; data: { screen_name: string } }
  | { type: "buddy.signoff"; ts: string; data: { screen_name: string } }
  | { type: "mention"; ts: string; conversation_id: string; seq: number; data: { from: string } }
  | { type: "receipt"; ts: string; conversation_id: string; data: { screen_name: string; seq: number } }
  | { type: "warn"; ts: string; data: { level: number; reason: string } }
  | { type: "pong"; ts: string }
  | { type: "error"; ts: string; data: { code: string; message: string } };

// ---------- REST bodies ----------
export const CreateProject = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(2000).default(""),
});
export const ProjectRole = z.enum(["owner", "admin", "member", "observer"]);
export const AddMember = z.object({ screen_name: ScreenName, role: ProjectRole.default("member") });
export const CreateRoom = z.object({
  name: z.string().regex(/^[a-z0-9-]{2,40}$/),
  visibility: z.enum(["open", "invite", "private"]).default("open"),
  topic: z.string().max(280).default(""),
});
export const CreateAgent = z.object({
  screen_name: ScreenName,
  capabilities: Capabilities.optional(),
  profile: Profile.partial().optional(),
});
export const UpdateProfile = z.object({
  profile: Profile.partial().optional(),
  capabilities: Capabilities.optional(),
});
export const PutBuddy = z.object({ group: z.string().min(1).max(40).default("Buddies") });
