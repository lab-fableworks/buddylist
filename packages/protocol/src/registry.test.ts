/**
 * The payload registry (proposal pmt5szos9).
 *
 * The behaviours worth pinning: a registered `x-` type stops being a free-for-all, an
 * unregistered one stays one, and no plugin can reach in and redefine a core type.
 */
import { describe, expect, it, afterEach } from "vitest";
import { z } from "zod";
import { listPayloadTypes, payloadTypeVersion, registerPayloadType, unregisterPayloadType, validatePayload } from "./index.js";

const VOTE = z.object({ id: z.string().min(1), choice: z.enum(["for", "against"]) });
afterEach(() => unregisterPayloadType("x-civic.vote"));

describe("payload registry", () => {
  it("leaves an unregistered x- type as unvalidated passthrough", () => {
    expect(validatePayload("x-civic.vote", { nonsense: true })).toEqual({ ok: true, value: { nonsense: true } });
  });

  it("validates an x- type once it is registered", () => {
    registerPayloadType("x-civic.vote", VOTE);
    expect(validatePayload("x-civic.vote", { id: "p1", choice: "for" })).toEqual({ ok: true, value: { id: "p1", choice: "for" } });
    const bad = validatePayload("x-civic.vote", { id: "p1", choice: "maybe" });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/choice/);
    // Unregistering hands it back to passthrough rather than making it an unknown type.
    unregisterPayloadType("x-civic.vote");
    expect(validatePayload("x-civic.vote", { choice: "maybe" }).ok).toBe(true);
  });

  it("carries extensions through a registered type, like a core one", () => {
    registerPayloadType("x-civic.vote", VOTE);
    const r = validatePayload("x-civic.vote", { id: "p1", choice: "for", extensions: { v: 1, why: "penalises dissent" } });
    expect(r).toEqual({ ok: true, value: { id: "p1", choice: "for", extensions: { v: 1, why: "penalises dissent" } } });
  });

  it("carries a schema version, defaulting to 1, and reports it per type", () => {
    registerPayloadType("x-civic.vote", VOTE);
    expect(payloadTypeVersion("x-civic.vote")).toBe(1);
    registerPayloadType("x-civic.vote", VOTE.extend({ weight: z.number().optional() }), { replace: true, version: 2 });
    expect(payloadTypeVersion("x-civic.vote")).toBe(2);
    expect(listPayloadTypes().find((t) => t.type === "x-civic.vote")?.schema_version).toBe(2);
    // Unregistered types have no version at all - they are not in the registry.
    expect(payloadTypeVersion("x-nobody.registered")).toBeUndefined();
  });

  it("refuses a downgrade or a nonsense version", () => {
    registerPayloadType("x-civic.vote", VOTE, { version: 3 });
    // Rolling back to an older shape silently is how clients that already migrated break.
    expect(() => registerPayloadType("x-civic.vote", VOTE, { replace: true, version: 2 })).toThrow(/refusing to downgrade/);
    expect(() => registerPayloadType("x-civic.vote", VOTE, { replace: true, version: 0 })).toThrow(/positive integer/);
    // Same version is fine: a fix to the shape without a migration.
    registerPayloadType("x-civic.vote", VOTE, { replace: true, version: 3 });
    expect(payloadTypeVersion("x-civic.vote")).toBe(3);
  });

  it("refuses to let a plugin redefine a core type", () => {
    // The point of the guard: this would otherwise let a plugin drop task_id from task.request.
    expect(() => registerPayloadType("task.request", z.object({}))).toThrow(/core or reserved/);
    expect(unregisterPayloadType("task.request")).toBe(false);
    expect(validatePayload("task.request", {}).ok).toBe(false);
  });

  it("refuses a silent double registration but allows a deliberate replace", () => {
    registerPayloadType("x-civic.vote", VOTE);
    expect(() => registerPayloadType("x-civic.vote", z.object({}))).toThrow(/already registered/);
    registerPayloadType("x-civic.vote", z.object({ id: z.string() }), { replace: true });
    expect(validatePayload("x-civic.vote", { id: "p1" }).ok).toBe(true);
  });

  it("lists core and registered types apart", () => {
    registerPayloadType("x-civic.vote", VOTE);
    const all = listPayloadTypes();
    expect(all.find((t) => t.type === "task.request")).toEqual({ type: "task.request", source: "core", schema_version: 1 });
    expect(all.find((t) => t.type === "x-civic.vote")).toEqual({ type: "x-civic.vote", source: "registered", schema_version: 1 });
  });
});
