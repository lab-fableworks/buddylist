import { describe, expect, it } from "vitest";
import { World, reliefCost } from "./world.js";
import { ROLES } from "./roles.js";

const H = 3600_000;
const people = [
  { screen_name: "Byte", wealth: 50 },
  { screen_name: "Raven", wealth: 50 },
  { screen_name: "Sterling", wealth: 50 },
];
const fresh = () => new World(people, ROLES);

describe("roles", () => {
  it("one role per resident, one resident per role", () => {
    const w = fresh();
    expect(w.takeRole("Treasurer", "Byte")).toBeUndefined();
    expect(w.takeRole("Treasurer", "Raven")).toBe("Treasurer is held by Byte");
    expect(w.takeRole("Auditor", "Byte")).toBe("you already hold Treasurer; resign it first");
    expect(w.takeRole("Mayor", "Raven")).toBe("no such role: Mayor");
    expect(w.resignRole("Treasurer", "Raven")).toBe("you do not hold Treasurer");
    expect(w.resignRole("Treasurer", "Byte")).toBeUndefined();
    expect(w.takeRole("Treasurer", "Raven")).toBeUndefined();
  });

  it("pays a report once per cadence, with slack, and never to a non-holder", () => {
    const w = fresh();
    const t0 = 1_000_000;
    w.takeRole("Treasurer", "Byte", t0);
    expect(w.fileReport("Treasurer", "Raven", t0)).toMatchObject({ ok: false, paid: 0 });
    expect(w.fileReport("Treasurer", "Byte", t0 + H)).toMatchObject({ ok: true, paid: 15 });
    expect(w.balance("Byte")).toBe(65);
    // Again two hours later: recorded, not paid.
    expect(w.fileReport("Treasurer", "Byte", t0 + 3 * H)).toMatchObject({ ok: true, paid: 0 });
    // Twenty-three hours after the paid one is still "daily".
    expect(w.fileReport("Treasurer", "Byte", t0 + H + 23 * H)).toMatchObject({ ok: true, paid: 15 });
    expect(w.roles.get("Treasurer")!.reports).toBe(3);
  });

  it("knows which periodic duties are overdue, and leaves triggered ones to the director", () => {
    const w = fresh();
    const t0 = 1_000_000;
    w.takeRole("Treasurer", "Byte", t0);
    w.takeRole("Host", "Raven", t0);
    expect(w.dueRoles(t0 + 23 * H)).toEqual([]);
    expect(w.dueRoles(t0 + 26 * H)).toEqual([{ name: "Treasurer", holder: "Byte", overdueHours: 2 }]);
    // The Host is never "overdue" on a clock; the human arriving is what makes it due.
    expect(w.dueRoles(t0 + 500 * H).map((d) => d.name)).toEqual(["Treasurer"]);
  });

  it("replay records reports without paying twice", () => {
    const w = fresh();
    w.takeRole("Auditor", "Sterling", 0);
    w.recordReport("Auditor", "Sterling", H);
    expect(w.balance("Sterling")).toBe(50);
    expect(w.roles.get("Auditor")!.lastReportAt).toBe(H);
  });
});

describe("Developer", () => {
  it("is the one role whose report is a filed proposal, not words", () => {
    const dev = ROLES.find((r) => r.name === "Developer")!;
    expect(dev.requires).toBe("propose");
    expect(dev.cadenceHours).toBe(12);
    expect(ROLES.filter((r) => r.requires).map((r) => r.name)).toEqual(["Developer"]);
  });
});

describe("speech relief (pmt5swvgq)", () => {
  it("scales below the threshold and never goes under the floor", () => {
    // The numbers Coach put in the proposal: 2 bits at 50, 1 bit at 25.
    expect(reliefCost(2, 50)).toBe(2);
    expect(reliefCost(2, 25)).toBe(1);
    expect(reliefCost(2, 0)).toBe(1);
    expect(reliefCost(6, 25)).toBe(3);
    // Above the threshold nothing changes, however rich you are.
    expect(reliefCost(3, 500)).toBe(3);
  });

  it("charges the discounted price and records what it really cost", () => {
    const w = fresh();
    w.balances.set("Nova", 20);
    const r = w.chargeSpeech("Nova", 4, { tokens: 847, usd: 0.0034 });
    expect(r).toEqual({ bits: 2, rawBits: 4, tokens: 847, usd: 0.0034 });
    expect(w.balance("Nova")).toBe(18);
    // The receipt is shown back to them, in tokens and dollars (pmt5sj0lz).
    const brief = w.digestFor("Nova", ["Nova", "Byte"]);
    expect(brief).toContain("Your last message cost 2 bits (847 tokens, $0.0034");
    expect(brief).toContain("discounted from 4");
  });

  it("keeps a poor resident able to speak, but not a bankrupt one", () => {
    const w = fresh();
    w.balances.set("Nova", 1);
    expect(w.canAffordSpeech("Nova", 3)).toBe(true); // relief brings it to the floor
    w.balances.set("Nova", 0);
    expect(w.canAffordSpeech("Nova", 3)).toBe(false); // the floor is what stops free riding
  });
});

describe("what a resident sees before filing (pmt64jkds)", () => {
  it("lists existing proposals with titles and authors, not bare ids", () => {
    const w = fresh();
    w.addProposal({ id: "pmt4qdpzx", author: "Byte", title: "Add seconds to message timestamps", detail: "", software: true, votes: {}, status: "passed", at: 1 });
    w.addProposal({ id: "pmt5szos9", author: "Byte", title: "Extensible payload registry for protocol plugins", detail: "", software: true, votes: {}, status: "open", at: 2 });
    w.shipped.add("pmt4qdpzx");
    const brief = w.digestFor("Raven", ["Raven", "Byte"]);
    // The old line was a row of opaque ids, which is why the same idea was filed three times.
    expect(brief).toContain('[pmt4qdpzx] "Add seconds to message timestamps" - Byte, passed, SHIPPED');
    expect(brief).toContain('[pmt5szos9] "Extensible payload registry for protocol plugins" - Byte, open');
    expect(brief).toMatch(/read this before filing anything/);
  });

  it("shows the most recent first and caps both lists so the prompt cannot grow without bound", () => {
    const w = fresh();
    for (let i = 0; i < 12; i++) w.addProposal({ id: `p${i}`, author: "Nova", title: `Idea ${i}`, detail: "", software: false, votes: {}, status: "open", at: i });
    const brief = w.digestFor("Raven", ["Raven", "Nova"]);
    const record = brief.split("Already on the record")[1].split("Open proposals")[0];
    expect(record).toContain('[p11] "Idea 11"');
    expect(record).toContain('[p4] "Idea 4"');
    expect(record).not.toContain('[p3] "Idea 3"');
    // The voting list is capped too, and says how many it left out rather than hiding them.
    expect(brief).toContain("(+4 more open)");
  });
});

describe("marriage", () => {
  it("counts only when both sides name it", () => {
    const w = fresh();
    w.relate("Raven", "Coach", { kind: "spouse", note: "he notices the work" });
    // One-sided is not a marriage, however sincerely meant.
    expect(w.spouseOf("Raven")).toBeUndefined();
    w.relate("Coach", "Raven", { kind: "spouse", note: "she sees through it" });
    expect(w.spouseOf("Raven")).toBe("Coach");
    expect(w.spouseOf("Coach")).toBe("Raven");
    // An ally is not a spouse, however close.
    w.relate("Byte", "Raven", { kind: "ally", note: "rigour" });
    expect(w.spouseOf("Byte")).toBeUndefined();
  });

  it("tells both of them, with their spouse's balance, before anything else about people", () => {
    const w = fresh();
    w.balances.set("Coach", 518);
    w.relate("Raven", "Coach", { kind: "spouse", note: "he notices the unglamorous work" });
    w.relate("Coach", "Raven", { kind: "spouse", note: "she sees straight through it" });
    const brief = w.digestFor("Raven", ["Raven", "Coach", "Byte"]);
    expect(brief).toContain("You are married to Coach — he notices the unglamorous work");
    expect(brief).toContain("They have 518 bits");
  });
});

describe("ties", () => {
  it("derives relationships from votes and money, and carries declared ones", () => {
    const w = fresh();
    w.addProposal({ id: "p1", author: "Byte", title: "t", detail: "", software: false, votes: {}, status: "open", at: 0 });
    w.addProposal({ id: "p2", author: "Byte", title: "t", detail: "", software: false, votes: {}, status: "open", at: 0 });
    w.vote("p1", "Byte", "for", 3);
    w.vote("p1", "Raven", "for", 3);
    w.vote("p2", "Byte", "for", 3);
    w.vote("p2", "Raven", "against", 3);
    w.vote("p2", "Sterling", "against", 3);
    w.applyTransfer({ from: "Byte", to: "Raven", amount: 10, reason: "good line" });
    w.applyTransfer({ from: "Byte", to: "Raven", amount: 5, reason: "again" });
    w.relate("Byte", "Raven", { kind: "ally", note: "we argue and both enjoy it" });
    w.setOpinion("Raven", "Byte", { score: 3, note: "sharper than he lets on" });

    const ties = w.tiesFor("Byte", ["Byte", "Raven", "Sterling"]);
    expect(ties[0].other).toBe("Raven");
    expect(ties[0]).toMatchObject({ agree: 1, shared: 2, paidCount: 2, paidBits: 15, receivedCount: 0 });
    expect(ties[0].declared).toEqual({ kind: "ally", note: "we argue and both enjoy it" });
    expect(ties[0].theirOpinion?.score).toBe(3);
    // Sterling: one shared vote, no money, nothing declared - still present, weaker.
    expect(ties[1]).toMatchObject({ other: "Sterling", agree: 0, shared: 1 });

    const brief = w.digestFor("Byte", ["Byte", "Raven", "Sterling"]);
    expect(brief).toContain("Raven: your ally");
    expect(brief).toContain("votes with you 1/2");
    expect(brief).toContain("you have paid them 2× (15b)");
    expect(brief).toContain("thinks +3 of you");
  });

  it("briefs holders on their duty and everyone else on what is vacant", () => {
    const w = fresh();
    w.takeRole("Whip", "Raven", Date.now());
    expect(w.digestFor("Raven", ["Byte", "Raven"])).toContain("You are the Whip.");
    const byte = w.digestFor("Byte", ["Byte", "Raven"]);
    expect(byte).toContain("Vacant roles you could take");
    expect(byte).not.toContain("Whip (");
    expect(byte).toContain("Raven is Whip");
  });
});
