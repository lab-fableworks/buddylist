import { describe, expect, it } from "vitest";
import { METRICS, Show, SHOW_TYPES } from "./show.js";
import { World } from "./world.js";
import { ROLES } from "./roles.js";

const H = 3600_000;
const CAST = ["Ace", "Byte", "Halo", "Vesper"];
const people = CAST.map((n) => ({ screen_name: n, wealth: 100 }));
const fresh = () => ({ show: new Show(CAST), world: new World(people, ROLES) });

describe("challenges", () => {
  it("rotates metrics and snapshots a baseline so only movement counts", () => {
    const { show, world } = fresh();
    expect(show.nextMetric()).toBe("net_tips");
    world.applyTransfer({ from: "Byte", to: "Vesper", amount: 30, reason: "pre-season retainer" });
    const baseline = show.baseline(world);
    show.apply(SHOW_TYPES.challenge, { id: "c1", metric: "net_tips", ends_at: 24 * H, baseline }, "BigBrother", 0);
    // Vesper's pre-existing 30 is baked into the baseline; the window starts level.
    expect(show.scores(world)).toEqual({ Ace: 0, Byte: 0, Halo: 0, Vesper: 0 });
    world.applyTransfer({ from: "Ace", to: "Halo", amount: 10, reason: "good bread" });
    world.applyTransfer({ from: "Vesper", to: "Halo", amount: 5, reason: "welcome" });
    expect(show.challengeWinner(world)).toMatchObject({ winner: "Halo" });
    // Mutual back-scratching nets out: the metric is received minus sent.
    expect(show.scores(world).Ace).toBe(-10);
  });

  it("declares no winner when nobody moved the number", () => {
    const { show, world } = fresh();
    show.apply(SHOW_TYPES.challenge, { id: "c1", metric: "net_tips", ends_at: 24 * H, baseline: show.baseline(world) }, "BigBrother", 0);
    expect(show.challengeWinner(world).winner).toBeNull();
  });

  it("closing a challenge grants immunity and advances the rotation", () => {
    const { show } = fresh();
    show.apply(SHOW_TYPES.challenge, { id: "c1", metric: "net_tips", ends_at: 0, baseline: {} }, "BigBrother", 0);
    show.apply(SHOW_TYPES.result, { id: "c1", winner: "Halo", prize: 25 }, "BigBrother", H);
    expect(show.immunity).toBe("Halo");
    expect(show.challenge).toBeUndefined();
    expect(show.nextMetric()).toBe("passed");
  });
});

describe("evictions", () => {
  const open = (show: Show) => show.apply(SHOW_TYPES.eviction, { id: "e1", ends_at: 12 * H }, "BigBrother", 0);

  it("validates votes: no self, no immune, no ghosts, no jury", () => {
    const { show } = fresh();
    expect(show.castError("Ace", "Byte")).toBe("no eviction or finale vote is open right now");
    open(show);
    show.immunity = "Halo";
    expect(show.castError("Ace", "Ace")).toContain("yourself");
    expect(show.castError("Ace", "Halo")).toContain("immunity");
    expect(show.castError("Ace", "Nobody")).toContain("not in the house");
    expect(show.castError("Ace", "Byte")).toBeUndefined();
  });

  it("counts one vote per voter (a repeat changes it) and breaks ties against the poorer contestant", () => {
    const { show, world } = fresh();
    open(show);
    show.apply(SHOW_TYPES.evictVote, { id: "e1", target: "Byte" }, "Ace", H);
    show.apply(SHOW_TYPES.evictVote, { id: "e1", target: "Vesper" }, "Ace", H); // changed mind
    show.apply(SHOW_TYPES.evictVote, { id: "e1", target: "Byte" }, "Halo", H);
    world.credit("Byte", 50); // Byte 150, Vesper 100: the tie evicts Vesper
    const r = show.evictionResult(world);
    expect(r.tally).toEqual({ Byte: 1, Vesper: 1 });
    expect(r.out).toBe("Vesper");
  });

  it("an evicted contestant joins the jury, loses immunity, and stops counting as active", () => {
    const { show } = fresh();
    show.immunity = "Byte";
    show.apply(SHOW_TYPES.evicted, { id: "e1", name: "Byte" }, "BigBrother", H);
    expect(show.isEvicted("Byte")).toBe(true);
    expect(show.immunity).toBeUndefined();
    expect(show.active()).toEqual(["Ace", "Halo", "Vesper"]);
    expect(show.jury()).toEqual(["Byte"]);
    // Replay of the same event does not double-evict.
    show.apply(SHOW_TYPES.evicted, { id: "e1", name: "Byte" }, "BigBrother", H);
    expect(show.jury()).toEqual(["Byte"]);
  });
});

describe("the finale", () => {
  it("opens only at two remaining, takes jury votes only, and majority wins", () => {
    const { show, world } = fresh();
    expect(show.finaleDue()).toBe(false);
    show.apply(SHOW_TYPES.evicted, { id: "e1", name: "Byte" }, "BigBrother", H);
    show.apply(SHOW_TYPES.evicted, { id: "e2", name: "Ace" }, "BigBrother", 2 * H);
    expect(show.finaleDue()).toBe(true);
    show.apply(SHOW_TYPES.finale, { id: "f1", ends_at: 48 * H }, "BigBrother", 3 * H);
    expect(show.castError("Halo", "Vesper")).toContain("only the jury");
    expect(show.castError("Byte", "Vesper")).toBeUndefined();
    show.apply(SHOW_TYPES.evictVote, { id: "f1", target: "Vesper" }, "Byte", 4 * H);
    show.apply(SHOW_TYPES.evictVote, { id: "f1", target: "Halo" }, "Ace", 4 * H);
    world.credit("Vesper", 10); // tie-break: the richer finalist played the economy better
    expect(show.finaleResult(world).winner).toBe("Vesper");
    show.apply(SHOW_TYPES.winner, { name: "Vesper" }, "BigBrother", 5 * H);
    expect(show.winner).toBe("Vesper");
    expect(show.challengeDue(100 * H, H)).toBe(false); // the season is over
  });
});

describe("season opening", () => {
  it("a seeded fresh season owes a challenge immediately and an eviction only after a full cadence", () => {
    const { show } = fresh();
    const t0 = 1000 * H; // a realistic clock: well past every cadence, as Date.now() always is
    show.seed(t0);
    expect(show.challengeDue(t0 + 1, 24 * H)).toBe(true);
    expect(show.evictionDue(t0 + 1, 72 * H)).toBe(false);
    expect(show.evictionDue(t0 + 73 * H, 72 * H)).toBe(true);
  });

  it("a voided eviction (empty name) closes the window, restarts the clock, and evicts nobody", () => {
    const { show } = fresh();
    show.apply(SHOW_TYPES.eviction, { id: "e1", ends_at: 12 * H }, "BigBrother", 0);
    show.apply(SHOW_TYPES.evicted, { id: "e1", name: "", tally: {} }, "BigBrother", H);
    expect(show.eviction).toBeUndefined();
    expect(show.jury()).toEqual([]);
    expect(show.lastEvictionClosedAt).toBe(H);
    // A name from outside the cast is equally not an eviction.
    show.apply(SHOW_TYPES.evicted, { id: "e2", name: "BigBrother" }, "BigBrother", 2 * H);
    expect(show.jury()).toEqual([]);
  });

  it("applying the same beat twice (socket echo) changes nothing", () => {
    const { show } = fresh();
    show.apply(SHOW_TYPES.challenge, { id: "c1", metric: "net_tips", ends_at: 24 * H, baseline: {} }, "BigBrother", 0);
    show.apply(SHOW_TYPES.challenge, { id: "c1", metric: "net_tips", ends_at: 24 * H, baseline: {} }, "BigBrother", 0);
    expect(show.challengesRun).toBe(1);
    show.apply(SHOW_TYPES.eviction, { id: "e1", ends_at: 12 * H }, "BigBrother", H);
    show.apply(SHOW_TYPES.evictVote, { id: "e1", target: "Byte" }, "Ace", 2 * H);
    show.apply(SHOW_TYPES.eviction, { id: "e1", ends_at: 12 * H }, "BigBrother", 2 * H); // echo must not wipe votes
    expect(show.eviction!.votes).toEqual({ Ace: "Byte" });
  });
});

describe("cadence", () => {
  it("never stacks beats: no challenge during an eviction, no eviction at final two", () => {
    const { show } = fresh();
    expect(show.challengeDue(25 * H, 24 * H)).toBe(true);
    show.apply(SHOW_TYPES.eviction, { id: "e1", ends_at: 30 * H }, "BigBrother", 25 * H);
    expect(show.challengeDue(26 * H, 24 * H)).toBe(false);
    show.apply(SHOW_TYPES.evicted, { id: "e1", name: "Byte" }, "BigBrother", 30 * H);
    show.apply(SHOW_TYPES.evicted, { id: "e2", name: "Ace" }, "BigBrother", 31 * H);
    expect(show.evictionDue(100 * H, H)).toBe(false); // two left - that is the finale's job
  });
});

describe("metric sanity", () => {
  it("every metric is a pure function of world state", () => {
    const { world } = fresh();
    world.applyTransfer({ from: "Ace", to: "Halo", amount: 10, reason: "x" });
    world.addProposal({ id: "p1", author: "Byte", title: "T", detail: "", software: true, votes: {}, status: "passed", at: 0 });
    world.addProposal({ id: "p2", author: "Halo", title: "U", detail: "", software: false, votes: { Ace: "for" }, status: "open", at: 0 });
    expect(METRICS.net_tips.value(world, "Halo")).toBe(10);
    expect(METRICS.passed.value(world, "Byte")).toBe(1);
    expect(METRICS.votes.value(world, "Ace")).toBe(1);
    expect(METRICS.bits.value(world, "Ace")).toBe(90);
  });
});
