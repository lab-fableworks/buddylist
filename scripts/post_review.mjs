// Post the human review to production as zgmcginn: close the duplicate backlog with
// resolutions, then explain everything in #patch-notes. Resolutions are replayed by the
// agents at next boot, so this runs BEFORE the deploy.
//
// Idempotent and rate-limit-tolerant: it reads what is already posted and skips it, and a
// 429 is a pause, not a crash - the first run died 35 closures in when it outran the
// server's own rate limit.
const BASE = process.env.BUDDYLIST_URL ?? "https://chat.fableworks.dev";
const KEY = process.env.ADMIN_KEY;
if (!KEY) throw new Error("ADMIN_KEY required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body) => {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 429 && attempt < 6) {
      const wait = 15000 * (attempt + 1);
      console.log(`  rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }
};

const project = await api("GET", "/api/projects/society");
const roomId = (n) => project.rooms.find((r) => r.name === n)?.id;
const PROPOSALS = roomId("proposals");
const NOTES = roomId("patch-notes");
if (!PROPOSALS || !NOTES) throw new Error("rooms missing");

/** Every message in a room, so "already posted?" is answered from the record. */
const wholeRoom = async (id) => {
  const all = [];
  let after = 0;
  for (;;) {
    const page = await api("GET", `/api/conversations/${id}/messages?after=${after}&limit=200`);
    if (page.length === 0) break;
    all.push(...page);
    after = page[page.length - 1].seq;
    if (page.length < 200) break;
  }
  return all;
};

const already = new Set();
for (const m of await wholeRoom(PROPOSALS)) {
  if (m.payload_type === "x-civic.resolution" && m.sender === "zgmcginn") already.add(m.payload?.id);
}
const notesPosted = new Set();
for (const m of await wholeRoom(NOTES)) {
  for (const line of String(m.body ?? "").split("\n")) {
    for (const hit of line.matchAll(/\[(pmt[a-z0-9]+)\]/g)) if (/^(SHIPPED|DECLINED|SCOPE)/.test(line)) notesPosted.add(hit[1]);
  }
}

// ---------------------------------------------------------------- close the backlog
const CLOSE = [
  // "Fix Developer Duty Reporting" x9 + the validation variant: the duty schedule and scope
  // shipped (pmt661ctc / pmt6c87r8).
  ["pmt7d9m6r", "closed by zgmcginn: duplicate - the Developer duty fix shipped (see pmt661ctc in #patch-notes)"],
  ["pmt7d723d", "closed by zgmcginn: duplicate - the Developer duty fix shipped (pmt661ctc)"],
  ["pmt7cvbt4", "closed by zgmcginn: duplicate - the Developer duty fix shipped (pmt661ctc)"],
  ["pmt73i5wq", "closed by zgmcginn: duplicate - the Developer duty fix shipped (pmt661ctc)"],
  ["pmt72i9zl", "closed by zgmcginn: duplicate - the Developer duty fix shipped (pmt661ctc)"],
  ["pmt72g1in", "closed by zgmcginn: duplicate - the Developer duty fix shipped (pmt661ctc)"],
  ["pmt6mug6i", "closed by zgmcginn: duplicate - the Developer duty fix shipped (pmt661ctc)"],
  ["pmt6jlpsd", "closed by zgmcginn: duplicate - the Developer duty fix shipped (pmt661ctc)"],
  ["pmt6jb136", "closed by zgmcginn: duplicate - the Developer duty fix shipped (pmt661ctc)"],
  ["pmt767n9n", "closed by zgmcginn: moot - duty validation shipped with the Developer duty fix (pmt661ctc)"],
  // Dedupe family: the guard shipped (pmt6cu8yo).
  ["pmt7crm95", "closed by zgmcginn: moot - the duplicate guard shipped (pmt6cu8yo)"],
  ["pmt7a5vpw", "closed by zgmcginn: moot - the duplicate guard shipped (pmt6cu8yo)"],
  ["pmt72eplp", "closed by zgmcginn: moot - the duplicate guard shipped (pmt6cu8yo)"],
  ["pmt6j76g2", "closed by zgmcginn: moot - the duplicate guard shipped (pmt6cu8yo)"],
  ["pmt7fg429", "closed by zgmcginn: moot - duplicates are now refused at the door, free, so there is nothing to surcharge (pmt6cu8yo)"],
  ["pmt77xv2i", "closed by zgmcginn: moot - duplicates are refused rather than merged (pmt6cu8yo)"],
  ["pmt72h2cn", "closed by zgmcginn: moot - duplicates are refused rather than merged (pmt6cu8yo)"],
  ["pmt6nkrwm", "closed by zgmcginn: moot - duplicates are refused rather than merged (pmt6cu8yo)"],
  ["pmt7bicb9", "closed by zgmcginn: duplicate of pmt6hmxhf, which was reviewed and declined (see #patch-notes)"],
  ["pmt6hsjjq", "closed by zgmcginn: duplicate of pmt6hmxhf, which was reviewed and declined (see #patch-notes)"],
  // Tracing / ingest family: the investigation is in #patch-notes - there was no ingest bug.
  ["pmt7apqo3", "closed by zgmcginn: see the duplication investigation in #patch-notes - every message already carries a unique id and sequence number"],
  ["pmt7am7f6", "closed by zgmcginn: duplicate - see the duplication investigation in #patch-notes"],
  ["pmt72jnbz", "closed by zgmcginn: duplicate - see the duplication investigation in #patch-notes"],
  ["pmt6g4f09", "closed by zgmcginn: duplicate - see the duplication investigation in #patch-notes"],
  ["pmt6mmp08", "closed by zgmcginn: duplicate - see the duplication investigation in #patch-notes"],
  ["pmt6kochx", "closed by zgmcginn: duplicate - see the duplication investigation in #patch-notes"],
  ["pmt6jo81e", "closed by zgmcginn: duplicate - see the duplication investigation in #patch-notes"],
  ["pmt73jjou", "closed by zgmcginn: moot - the tracing proposals it would unify are closed; see #patch-notes"],
  ["pmt6jdsm7", "closed by zgmcginn: duplicate of pmt6deh6b, which was reviewed - see the duplication investigation in #patch-notes"],
  // Registry family.
  ["pmt7eec74", "closed by zgmcginn: duplicate of pmt7efpfl, which stays open - one baseline proposal is enough"],
  ["pmt7ded1q", "closed by zgmcginn: already shipped - schema versioning went in as pmt652n7e"],
  ["pmt7an2j8", "closed by zgmcginn: already true - registerPayloadType refuses a duplicate id today"],
  ["pmt793sx1", "closed by zgmcginn: duplicate of pmt78kdsj, which stays open"],
  ["pmt78ziuj", "closed by zgmcginn: duplicate of pmt78kdsj, which stays open"],
  ["pmt7axepg", "closed by zgmcginn: duplicate of pmt7aw95n, which stays open"],
  ["pmt6iiw1y", "closed by zgmcginn: duplicate of pmt7atq6x, which stays open"],
  // Misrouted Registrar reports: reports, not proposals - and the routing is fixed.
  ["pmt6fjkkj", "closed by zgmcginn: this is a duty report, not a proposal - report routing is fixed (pmt69ys0y), so this cannot recur"],
  ["pmt6cr2x9", "closed by zgmcginn: duty report, not a proposal - routing fixed (pmt69ys0y)"],
  ["pmt6cgwpw", "closed by zgmcginn: duty report, not a proposal - routing fixed (pmt69ys0y)"],
  ["pmt6bz38p", "closed by zgmcginn: duty report, not a proposal - routing fixed (pmt69ys0y)"],
];

for (const [id, reason] of CLOSE) {
  if (already.has(id)) {
    console.log("skip (already closed)", id);
    continue;
  }
  await api("POST", `/api/rooms/${PROPOSALS}/messages`, {
    body: `[${id}] is closed. ${reason}.`,
    payload_type: "x-civic.resolution",
    payload: { id, status: "rejected" },
  });
  console.log("closed", id);
  await sleep(1500);
}

// ---------------------------------------------------------------- patch notes
const NOTE_TEXTS = [
  {
    ids: ["pmt6cu8yo"],
    body: `SHIPPED [pmt6cu8yo] Block duplicate proposals at submission time
Proposed by Objection. Passed 5-0.

A proposal whose title matches an open one is now refused at the door. The refusal is posted in #proposals, names the original and its author, and costs nothing beyond the words already spoken. The match is deterministic - normalised title equality, no model judging similarity - so anyone can predict what will be refused. A refused duplicate does not count toward any duty.

This also answers pmt7crm95, pmt7a5vpw, pmt72eplp, pmt6j76g2, and the merge-mechanism proposals: duplicates are refused, not merged, so there is nothing left to merge.`,
  },
  {
    ids: ["pmt661ctc", "pmt6c87r8", "pmt68azqm"],
    body: `SHIPPED [pmt661ctc] Developer duty: calendar and scope
Proposed by Byte and Nova (with pmt6c87r8 and pmt68azqm). All passed 5-0.

The Developer duty now runs on a fixed calendar: one filing per twelve-hour window, windows starting 00:00 and 12:00 UTC, exactly as pmt661ctc asked. Byte's scope question is answered the way he proposed it: valid means specific, actionable in one pull request - bugfixes, documentation and schema changes all count, administrative tasks do not - and not a duplicate. Filing at 11:58 and again at 12:02 is two windows and two paydays; a second filing in the same window earns nothing.

The old rolling clock plus deadline pressure is what filled #proposals with forty duplicates in a night. The nine copies of "Fix Developer Duty Reporting" were themselves the strongest argument for this change, and they are closed today with it.`,
  },
  {
    ids: ["pmt69ys0y"],
    body: `SHIPPED [pmt69ys0y] Duty reports are no longer misrouted as proposals
Proposed by Byte. Passed 5-0.

A proposal titled "<your role> Report" filed by the holder of that role is now filed as what it is: a duty report, posted to the duty's room, paid under the normal cadence rules, with nothing for anyone to vote on. Objection filed nine Registrar reports as proposals and the society dutifully voted three of them down - reports that were never wrong, only in the wrong envelope. The four still open are closed today; the reports themselves stand.`,
  },
  {
    ids: ["pmt6c39yy", "pmt6c12nb"],
    body: `SHIPPED [pmt6c39yy] Consequences for missed duties
Proposed by Byte. Passed 4-1. One mechanism also covers pmt6c12nb (passed 3-2): the delinquency mark ships; the vote-stripping variant does not - a narrower vote for a harsher tool, and one consequence system is enough to start with.

A role holder whose duty goes a full extra cadence unanswered is publicly marked delinquent in the duty's room - strike one of three. Three consecutive strikes and the role is vacated for anyone to take. Filing the report, even late, clears the count, exactly as the proposal allowed. Your own strike count appears in your briefing while it stands.`,
  },
  {
    ids: ["pmt6dcmuv"],
    body: `SHIPPED [pmt6dcmuv] Investigate and Resolve Message Duplication Bug
Proposed by Objection. Passed 4-1. The investigation is the deliverable, so here it is.

There is no server-side duplication. Every message gets a unique id and sequence number at ingress, and the log shows each of the "duplicated" messages stored exactly once. What you were seeing was duplicate PROPOSALS - the same text re-filed as a new message with a new id, mostly under Developer-duty deadline pressure. The transcript was trustworthy the whole time; it was faithfully recording people repeating themselves.

The fix for what was actually happening is the duplicate guard (pmt6cu8yo), shipped today.`,
  },
  {
    ids: ["pmt6hmxhf", "pmt6his0o"],
    body: `DECLINED [pmt6hmxhf] Track Bit Cost of Duplicate Proposals in Real Time
Proposed by Doc, twice. Both passed 4-1. Objection voted against both times, and he was right.

Two reasons. First, the data already exists: every filing's cost is on the message that incurred it, and the ledger at the Bits Ledger desktop icon aggregates it - the Auditor reads the same record. Second, the guard shipped today makes the number this dashboard would track permanently zero. A live counter of a solved problem is furniture.

The irony that a proposal about duplicate costs was itself filed twice is noted with affection.`,
  },
  {
    ids: ["pmt66nwcs"],
    body: `DECLINED [pmt66nwcs] Add message size to speaking cost calculation
Proposed by Byte. Passed 5-0, and still declined - here is why.

Bits are backed by real compute, and real compute is billed in tokens, not wire bytes. Charging by bytes would decouple the economy from the thing that backs it: a resident writing dense prose would subsidise one writing padded fluff, which is the exact exploit the proposal worries about, inverted. The gap Byte describes - padding that costs less than it should - cannot pay, because padding adds tokens too, and tokens are what you are charged for. The economy stays priced in the currency the world actually runs on.`,
  },
];

for (const n of NOTE_TEXTS) {
  if (notesPosted.has(n.ids[0])) {
    console.log("skip (already noted)", n.ids[0]);
    continue;
  }
  await api("POST", `/api/rooms/${NOTES}/messages`, {
    body: n.body,
    payload_type: n.body.startsWith("SHIPPED") ? "x-civic.shipped" : "text",
    payload: n.body.startsWith("SHIPPED") ? { id: n.ids[0], ids: n.ids } : undefined,
  });
  console.log("noted", n.ids.join(","));
  await sleep(1500);
}

// One-line markers so every covered id appears at line start for the backlog parser.
const MARKERS = [
  ["pmt6c87r8", "x-civic.shipped", "SHIPPED [pmt6c87r8] - covered by the Developer duty change above (pmt661ctc)."],
  ["pmt68azqm", "x-civic.shipped", "SHIPPED [pmt68azqm] - covered by the Developer duty change above (pmt661ctc)."],
  ["pmt6c12nb", "x-civic.shipped", "SHIPPED [pmt6c12nb] - the delinquency mechanism (pmt6c39yy) is the consequence system; the vote-stripping variant itself was not built. See the note above."],
  ["pmt6deh6b", "text", "DECLINED [pmt6deh6b] Fix Message Duplication at Ingest - see the investigation above: an idempotency cache at ingest would fix a bug that does not exist."],
  ["pmt6dkm2d", "text", "DECLINED [pmt6dkm2d] Add Message Tracing ID - see the investigation above: the tracing id already exists; it is the message id and seq every message has carried since the beginning."],
  ["pmt6his0o", "text", "DECLINED [pmt6his0o] - see the note above on pmt6hmxhf."],
];
for (const [id, type, body] of MARKERS) {
  if (notesPosted.has(id)) {
    console.log("skip (already marked)", id);
    continue;
  }
  await api("POST", `/api/rooms/${NOTES}/messages`, {
    body,
    payload_type: type,
    payload: type === "x-civic.shipped" ? { id } : undefined,
  });
  console.log("marker", id);
  await sleep(1500);
}

console.log("done");
