import { describe, expect, it } from "vitest";
import { World, normTitle, reliefCost, type Proposal } from "./world.js";
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
    expect(w.takeRole("Treasurer", "Raven")).toBe("Treasurer is held by Byte, not vacant");
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

  it("replay pays the logged amount exactly once - the fix for the restart that erased Byte's 883 bits", () => {
    // Duty pay used to be, in the code's own words, "minted state that lives in the running
    // process": a restart rebuilt every balance from grants and transfers alone, silently
    // discarding every role payout, vote payout, and passed-proposal payout ever earned. The
    // x-role.report message already carried what was paid; replay just was not reading it.
    const w = fresh();
    w.takeRole("Auditor", "Sterling", 0);
    w.recordReport("Auditor", "Sterling", H, true, 20);
    expect(w.balance("Sterling")).toBe(70);
    // A second replay pass over the SAME message (a resumed or duplicate replay) must not
    // double-pay - callers only ever invoke this once per logged message, but the guard
    // belongs at the call site (one message = one recordReport call), not inside the method,
    // so this documents that recordReport itself is a plain, idempotent-per-call credit.
    w.recordReport("Auditor", "Sterling", 2 * H, true, 20);
    expect(w.balance("Sterling")).toBe(90);
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
describe("the notebook", () => {
  it("keeps a few lines, newest-in oldest-out, and dedupes a repeated line", () => {
    const w = fresh();
    for (const n of ["one", "two", "three"]) w.remember("Byte", n, 3);
    expect(w.notebooks.get("Byte")).toEqual(["one", "two", "three"]);
    // A fourth pushes the oldest out.
    w.remember("Byte", "four", 3);
    expect(w.notebooks.get("Byte")).toEqual(["two", "three", "four"]);
    // Re-writing a line it already holds moves it to newest rather than duplicating it.
    w.remember("Byte", "two", 3);
    expect(w.notebooks.get("Byte")).toEqual(["three", "four", "two"]);
  });

  it("trims blanks and overlong lines, and keeps notebooks private per resident", () => {
    const w = fresh();
    expect(w.remember("Raven", "   ")).toEqual([]);
    w.remember("Raven", "x".repeat(300));
    expect(w.notebooks.get("Raven")![0].length).toBe(160);
    expect(w.notebooks.get("Byte") ?? []).toEqual([]);
  });

  it("shows a resident their own notebook in the briefing, and nobody else's", () => {
    const w = fresh();
    w.remember("Byte", "Sterling still owes me 40 bits");
    w.remember("Raven", "Coach votes against me when it is quiet");
    const brief = w.digestFor("Byte", ["Byte", "Raven", "Sterling"]);
    expect(brief).toContain("Sterling still owes me 40 bits");
    expect(brief).not.toContain("Coach votes against me");
  });

  it("forgets a line on request", () => {
    const w = fresh();
    w.remember("Doc", "keep");
    w.remember("Doc", "drop");
    expect(w.forget("Doc", "drop")).toEqual(["keep"]);
  });
});

describe("paying for notebook lines", () => {
  const GOOD = "Sterling offered me thirty bits for a vote and pivoted when I refused";

  it("pays a substantive new line", () => {
    const w = fresh();
    expect(w.notebookPayable("Byte", GOOD, 0)).toEqual({ ok: true });
  });

  it("refuses filler: too short, too few words", () => {
    const w = fresh();
    expect(w.notebookPayable("Byte", "note", 0).ok).toBe(false);
    expect(w.notebookPayable("Byte", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 0).ok).toBe(false); // long, one word
  });

  it("never pays twice for the same line, even after it falls out of the notebook", () => {
    const w = fresh();
    w.recordNotebookPay("Byte", GOOD, 0);
    // Long past the cooldown, and the notebook itself has rolled over many times.
    expect(w.notebookPayable("Byte", GOOD, 99 * 3600_000).ok).toBe(false);
    // Punctuation and case are not a disguise.
    expect(w.notebookPayable("Byte", GOOD.toUpperCase() + "!!!", 99 * 3600_000).ok).toBe(false);
  });

  it("rate limits so nobody dumps a notebook full in one turn", () => {
    const w = fresh();
    w.recordNotebookPay("Byte", GOOD, 0);
    const other = "Coach keeps voting against whoever just did him a favour, every single time";
    expect(w.notebookPayable("Byte", other, 5 * 60_000).ok).toBe(false);
    expect(w.notebookPayable("Byte", other, 21 * 60_000).ok).toBe(true);
    // The limit is per resident, not global.
    expect(w.notebookPayable("Raven", other, 5 * 60_000).ok).toBe(true);
  });

  it("holds thirty lines before pushing the oldest out", () => {
    const w = fresh();
    for (let i = 0; i < 30; i++) w.remember("Byte", `line number ${i}`);
    expect(w.notebooks.get("Byte")).toHaveLength(30);
    w.remember("Byte", "the thirty-first");
    const kept = w.notebooks.get("Byte")!;
    expect(kept).toHaveLength(30);
    expect(kept[0]).toBe("line number 1");
    expect(kept.at(-1)).toBe("the thirty-first");
  });
});

describe("duplicate guard (pmt6cu8yo)", () => {
  const proposal = (id: string, title: string, status: Proposal["status"] = "open"): Proposal => ({ id, author: "Byte", title, detail: "", software: true, votes: {}, status, at: 0 });

  it("judges titles by their normalised form, not their punctuation", () => {
    expect(normTitle("Fix Developer Duty Reporting")).toBe(normTitle("  fix developer  duty reporting!! "));
    expect(normTitle("A")).not.toBe(normTitle("B"));
  });

  it("finds the open original and ignores decided ones", () => {
    const w = fresh();
    w.addProposal(proposal("p1", "Fix Developer Duty Reporting"));
    w.addProposal(proposal("p2", "Something Else Entirely", "rejected"));
    expect(w.duplicateOf("fix developer duty reporting")?.id).toBe("p1");
    expect(w.duplicateOf("Something Else Entirely")).toBeUndefined();
    expect(w.duplicateOf("A Genuinely New Idea")).toBeUndefined();
  });

  it("lets a title be refiled once the original is decided", () => {
    const w = fresh();
    w.addProposal(proposal("p1", "Fix It"));
    w.resolve("p1", "rejected");
    expect(w.duplicateOf("Fix It")).toBeUndefined();
  });
});

describe("misrouted duty reports (pmt69ys0y)", () => {
  it("recognises the holder filing their own report as a proposal", () => {
    const w = fresh();
    w.takeRole("Registrar", "Byte");
    expect(w.misroutedReport("Registrar Report: Current Message Extensions Registry", "Byte")).toBe("Registrar");
    expect(w.misroutedReport("registrar duty report", "Byte")).toBe("Registrar");
    // Someone else invoking the word, or a title merely containing it, stays a proposal.
    expect(w.misroutedReport("Registrar Report: whatever", "Raven")).toBeUndefined();
    expect(w.misroutedReport("Improve Registrar Report formatting", "Byte")).toBeUndefined();
  });
});

describe("anchored duty windows (pmt661ctc)", () => {
  // Developer: cadence 12h, anchored. Windows start at epoch multiples of 12h = UTC 00:00/12:00.
  const W12 = 12 * H;

  it("is due when the current calendar window has no report, not N hours after the last", () => {
    const w = fresh();
    w.takeRole("Developer", "Byte", 10 * W12 + 2 * H); // taken mid-window: that window is grace
    expect(w.dueRoles(10 * W12 + 11 * H)).toEqual([]);
    // The next window opens and the duty is due at once, however recent the last filing.
    expect(w.dueRoles(11 * W12 + H).map((d) => d.name)).toEqual(["Developer"]);
  });

  it("pays once per window: 11:58 and 12:02 are two windows and two paydays", () => {
    const w = fresh();
    w.takeRole("Developer", "Byte", 10 * W12);
    const before = w.balance("Byte");
    expect(w.fileReport("Developer", "Byte", 11 * W12 - 2 * 60_000).paid).toBe(12);
    expect(w.fileReport("Developer", "Byte", 11 * W12 + 2 * 60_000).paid).toBe(12);
    // A second filing in the same window earns nothing.
    expect(w.fileReport("Developer", "Byte", 11 * W12 + 3 * H).paid).toBe(0);
    expect(w.balance("Byte")).toBe(before + 24);
  });
});

describe("delinquency (pmt6c39yy)", () => {
  it("strikes after a full extra cadence of silence, and vacates at three", () => {
    const w = fresh();
    const t0 = 1_000_000;
    w.takeRole("Treasurer", "Byte", t0); // 24h cadence
    expect(w.sweepDelinquencies(t0 + 47 * H)).toEqual([]);
    expect(w.sweepDelinquencies(t0 + 49 * H)).toEqual([{ role: "Treasurer", holder: "Byte", count: 1, vacated: false }]);
    // The same silence is not struck twice; the clock restarts from the strike.
    expect(w.sweepDelinquencies(t0 + 50 * H)).toEqual([]);
    expect(w.sweepDelinquencies(t0 + 98 * H)[0]).toMatchObject({ count: 2, vacated: false });
    expect(w.sweepDelinquencies(t0 + 147 * H)[0]).toMatchObject({ count: 3, vacated: true });
    expect(w.roles.has("Treasurer")).toBe(false);
    expect(w.takeRole("Treasurer", "Raven")).toBeUndefined();
  });

  it("is cleared by any report, even a late one", () => {
    const w = fresh();
    const t0 = 1_000_000;
    w.takeRole("Treasurer", "Byte", t0);
    w.sweepDelinquencies(t0 + 49 * H);
    w.sweepDelinquencies(t0 + 98 * H);
    expect(w.roles.get("Treasurer")!.delinquencies).toBe(2);
    w.fileReport("Treasurer", "Byte", t0 + 99 * H);
    expect(w.roles.get("Treasurer")!.delinquencies).toBe(0);
    // The count says so in the holder's briefing while it stands.
    w.sweepDelinquencies(t0 + 148 * H);
    expect(w.digestFor("Byte", people.map((x) => x.screen_name))).toContain("DELINQUENT: 1 of 3");
  });

  it("replays a recorded strike instead of striking the same silence twice", () => {
    const w = fresh();
    const t0 = 1_000_000;
    w.takeRole("Treasurer", "Byte", t0);
    // A deploy replays the strike the last process posted at t0+49h...
    w.recordDelinquency("Treasurer", "Byte", 1, t0 + 49 * H);
    // ...so the sweep right after boot stays quiet, and the next strike lands a full
    // cadence later, continuing the count instead of restarting it.
    expect(w.sweepDelinquencies(t0 + 50 * H)).toEqual([]);
    expect(w.sweepDelinquencies(t0 + 98 * H)).toEqual([{ role: "Treasurer", holder: "Byte", count: 2, vacated: false }]);
  });

  it("counts a replayed software filing as the Developer's report (the filing is the duty)", () => {
    const w = fresh();
    const W12 = 12 * H;
    w.takeRole("Developer", "Byte", 10 * W12);
    // What replay does when it meets the holder's accepted software proposal:
    w.recordReport("Developer", "Byte", 11 * W12 + H, false);
    expect(w.dueRoles(11 * W12 + 2 * H)).toEqual([]);
    expect(w.roles.get("Developer")!.reports).toBe(0); // the x-role.report message carries the count
    expect(w.roles.get("Developer")!.delinquencies).toBe(0);
  });

  it("never strikes triggered roles - the human arriving is their clock", () => {
    const w = fresh();
    w.takeRole("Host", "Byte", 0);
    expect(w.sweepDelinquencies(1000 * H)).toEqual([]);
  });
});

describe("operator resolutions on replay", () => {
  it("closes an open proposal and refuses to reopen a decided one", () => {
    const w = fresh();
    w.addProposal({ id: "p1", author: "Byte", title: "T", detail: "", software: false, votes: {}, status: "open", at: 0 });
    w.resolve("p1", "rejected");
    expect(w.proposals.get("p1")!.status).toBe("rejected");
    w.resolve("p1", "passed");
    expect(w.proposals.get("p1")!.status).toBe("rejected");
  });
});
