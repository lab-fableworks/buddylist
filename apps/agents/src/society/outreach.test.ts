/**
 * Outreach state has to outlive the process that holds it.
 *
 * Raven told the human five separate times that she thought well of Coach. She was not
 * nagging: the "already said this" set lived only in memory and every deploy re-armed it.
 */
import { describe, expect, it } from "vitest";
import { Outreach } from "./outreach.js";
import { World } from "./world.js";
import { ROLES } from "./roles.js";

const cfg = { enabled: true, perResidentCooldownMs: 60 * 60_000, globalCooldownMs: 8 * 60_000, brokeAt: 12, strongOpinion: 4 };
const worldWithOpinion = () => {
  const w = new World([{ screen_name: "Raven", wealth: 550 }, { screen_name: "Coach", wealth: 518 }], ROLES);
  w.setOpinion("Raven", "Coach", { score: 5, note: "notices the unglamorous work" });
  return w;
};

describe("outreach across a restart", () => {
  it("fires a strong opinion once, then stays quiet", () => {
    const o = new Outreach({ ...cfg });
    const w = worldWithOpinion();
    const first = o.reasonFor("Raven", w);
    expect(first?.key).toBe("opinion:Coach:+");
    o.record("Raven", first!.key, w);
    expect(o.reasonFor("Raven", w)).toBeUndefined();
  });

  it("does not say it again after a restart, once the state is restored", () => {
    const before = new Outreach({ ...cfg });
    const w = worldWithOpinion();
    const r = before.reasonFor("Raven", w)!;
    before.record("Raven", r.key, w);
    const saved = before.snapshot("Raven");
    expect(saved.used).toContain("opinion:Coach:+");

    // A deploy: brand new process, same resident, same opinion.
    const after = new Outreach({ ...cfg });
    expect(after.reasonFor("Raven", w)?.key).toBe("opinion:Coach:+"); // this was the bug
    const fixed = new Outreach({ ...cfg });
    fixed.hydrate("Raven", saved);
    expect(fixed.reasonFor("Raven", w)).toBeUndefined();
  });

  it("ignores a missing or empty snapshot rather than throwing", () => {
    const o = new Outreach({ ...cfg });
    o.hydrate("Raven", undefined);
    o.hydrate("Raven", {});
    expect(o.reasonFor("Raven", worldWithOpinion())?.key).toBe("opinion:Coach:+");
  });
});
