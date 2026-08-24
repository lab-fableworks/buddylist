import { describe, expect, it } from "vitest";
import { deNarrate, looksNarrated, narrationShare, promisesProposal, stripSelfPrefix } from "./style.js";

describe("looksNarrated", () => {
  it("passes ordinary chat, including long-ish technical chat", () => {
    expect(looksNarrated("Sterling, that's a liability and you know it.")).toBe(false);
    expect(looksNarrated("The 5:1 ratio between answer payout and speaking cost is the right incentive. It makes serving the human the best-paid thing you can do, which is what we want.")).toBe(false);
    expect(looksNarrated("")).toBe(false);
  });
  it("catches stage directions, narrated openers, and essays", () => {
    expect(looksNarrated("*checks the room - just me, talking to an empty space* Right, everyone's away.")).toBe(true);
    expect(looksNarrated("I drain the last of the cold tea and set the mug down with a quiet clink.")).toBe(true);
    expect(looksNarrated("I settle back into my chair, book still closed on my lap.")).toBe(true);
    expect(looksNarrated(Array(90).fill("word").join(" "))).toBe(true);
  });
  it("does not mistake 'I think' or 'I sit on the fence' figures of speech for narration", () => {
    // Only physical-action openers count; the verb list is deliberately narrow.
    expect(looksNarrated("I think Byte is right about the registry.")).toBe(false);
    // Markdown emphasis is speech, not narration - Sterling lost the word *leverage* to this.
    expect(looksNarrated("It's not about charm, it's about *leverage*.")).toBe(false);
    expect(looksNarrated("*nods*")).toBe(true);
    expect(looksNarrated("*settles into the chair with a sigh*")).toBe(true);
    expect(looksNarrated("I voted against it because it penalises dissent.")).toBe(false);
  });
});

describe("stripSelfPrefix", () => {
  it("removes a resident's own name from the front of their own message", () => {
    expect(stripSelfPrefix("Marlowe: Heh, Nova, you always know.", "Marlowe")).toBe("Heh, Nova, you always know.");
    expect(stripSelfPrefix("marlowe:  spacing is odd", "Marlowe")).toBe("spacing is odd");
    // Some models copy the transcript the other way round.
    expect(stripSelfPrefix("me: finally, it shipped", "Byte")).toBe("finally, it shipped");
    // A model that prefixes once sometimes prefixes twice.
    expect(stripSelfPrefix("Marlowe: Marlowe: twice over", "Marlowe")).toBe("twice over");
  });

  it("leaves quoting and ordinary address alone", () => {
    // Marlowe quoting Byte is speech, not a stray prefix.
    expect(stripSelfPrefix("Byte: the registry shipped", "Marlowe")).toBe("Byte: the registry shipped");
    // A comma is address, not a prefix - even when it is your own name.
    expect(stripSelfPrefix("Nova, did you see this?", "Nova")).toBe("Nova, did you see this?");
  });
});

describe("deNarrate", () => {
  it("strips asterisk segments and keeps two sentences", () => {
    expect(deNarrate("*leans back* That is fair. The loophole was real. We used it. No point pretending otherwise.")).toBe("That is fair. The loophole was real.");
    // Emphasis keeps its word; only the direction is deleted.
    expect(deNarrate("*leans back* It's about *leverage*. And the returns.")).toBe("It's about leverage. And the returns.");
  });
});

describe("narrationShare", () => {
  it("measures the transcript, ignoring the sender prefix", () => {
    const lines = ["Nova: I drift in from somewhere, lost track of time again.", "Byte: yeah the registry is shipped", "Raven: *closes the book* Fair."];
    expect(narrationShare(lines)).toBeCloseTo(2 / 3);
    expect(narrationShare([])).toBe(0);
  });
});

describe("promisesProposal", () => {
  it("spots a promise to file", () => {
    expect(promisesProposal("okay, I'm going to stop second-guessing and actually post this proposal")).toBe(true);
    expect(promisesProposal("Let me write this up properly as a proposal")).toBe(true);
    expect(promisesProposal("I'll draft the co-author proposal tonight")).toBe(true);
  });
  it("ignores talk about proposals that is not a promise to file one", () => {
    expect(promisesProposal("Sterling's proposal penalises dissent.")).toBe(false);
    expect(promisesProposal("I voted for the proposal.")).toBe(false);
    expect(promisesProposal("I'm going to post in #market")).toBe(false);
  });
});
