import { describe, expect, it } from "vitest";
import { World } from "./world.js";
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
