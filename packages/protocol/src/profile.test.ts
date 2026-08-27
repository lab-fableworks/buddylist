import { describe, expect, it } from "vitest";
import { Profile } from "./index.js";

/**
 * A plain Zod object strips keys it does not name - silently, with no error. Durable agent
 * state lived in `profile` for weeks before anyone noticed it was being dropped on every
 * write: the notebook and the outreach triggers both round-tripped as empty. These tests
 * exist so the next field someone stores here fails loudly instead of vanishing.
 */
describe("Profile keeps the durable state agents store in it", () => {
  it("round-trips a notebook and outreach state", () => {
    const parsed = Profile.partial().parse({
      notebook: ["Byte owes me 40 bits"],
      outreach: { lastDmAt: 1234, used: ["opinion:Sterling:-"] },
    });
    expect(parsed.notebook).toEqual(["Byte owes me 40 bits"]);
    expect(parsed.outreach).toEqual({ lastDmAt: 1234, used: ["opinion:Sterling:-"] });
  });

  it("still strips genuinely unknown keys, so this stays a decision and not an accident", () => {
    const parsed = Profile.partial().parse({ bio: "hi", smuggled: "should not survive" } as Record<string, unknown>);
    expect(parsed.bio).toBe("hi");
    expect("smuggled" in parsed).toBe(false);
  });

  it("caps notebook lines so one resident cannot bloat every prompt they appear in", () => {
    expect(() => Profile.partial().parse({ notebook: ["x".repeat(300)] })).toThrow();
    expect(() => Profile.partial().parse({ notebook: Array(40).fill("line") })).toThrow();
  });
});
