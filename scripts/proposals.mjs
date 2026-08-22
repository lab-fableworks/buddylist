#!/usr/bin/env node
/**
 * Review what the society has proposed and decided.
 *
 * The society cannot change the codebase — a passed `software` proposal is a recommendation
 * waiting for a human. This is the tool for collecting those recommendations so they can be
 * triaged like any other backlog.
 *
 *   ADMIN_KEY=bl_... node scripts/proposals.mjs            # everything
 *   ADMIN_KEY=bl_... node scripts/proposals.mjs --software # only software changes
 *   ADMIN_KEY=bl_... node scripts/proposals.mjs --passed   # only what carried
 */
const BASE = process.env.BUDDYLIST_URL ?? "https://chat.fableworks.dev";
const KEY = process.env.ADMIN_KEY;
if (!KEY) {
  console.error("ADMIN_KEY required");
  process.exit(2);
}
const onlySoftware = process.argv.includes("--software");
const onlyPassed = process.argv.includes("--passed");

const api = async (path) => {
  const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
};

const project = await api("/api/projects/society");
// Proposals and votes live in #proposals, but shipment markers are posted to #patch-notes.
// Scanning only the first would report finished work as still outstanding.
const sources = ["proposals", "patch-notes"]
  .map((n) => project.rooms.find((r) => r.name === n))
  .filter(Boolean);
if (sources.length === 0) {
  console.error("no #proposals room - is the society set up?");
  process.exit(1);
}

// Page through the whole room; proposals are sparse among the votes.
const all = [];
for (const room of sources) {
  let after = 0;
  for (;;) {
    const page = await api(`/api/conversations/${room.id}/messages?after=${after}&limit=200`);
    if (page.length === 0) break;
    all.push(...page);
    after = page[page.length - 1].seq;
    if (page.length < 200) break;
  }
}

const proposals = new Map();
for (const m of all) {
  const p = m.payload ?? {};
  if (m.payload_type === "x-civic.proposal") {
      proposals.set(p.id, { id: p.id, author: m.sender, title: p.title, detail: p.detail ?? "", software: !!p.software, votes: [], status: "open", shipped: false, ts: m.ts });
  } else if (m.payload_type === "x-civic.vote" && proposals.has(p.id)) {
    // One vote per resident per proposal; a repeat changes the choice, it is not a second vote.
    // Counting messages here reported "8 for" on a proposal four people had voted on.
    const pr = proposals.get(p.id);
    const prior = pr.votes.find((v) => v.voter === m.sender);
    if (prior) {
      prior.choice = p.choice;
      pr.repeats = (pr.repeats ?? 0) + 1;
    } else pr.votes.push({ voter: m.sender, choice: p.choice });
  } else if (m.payload_type === "x-civic.resolution" && proposals.has(p.id)) {
    proposals.get(p.id).status = p.status;
  } else if (m.payload_type === "x-civic.shipped" && proposals.has(p.id)) {
    proposals.get(p.id).shipped = true;
  } else {
    const plain = /^SHIPPED[^[]*\[([a-z0-9]+)\]/im.exec(m.body ?? "");
    if (plain && proposals.has(plain[1])) proposals.get(plain[1]).shipped = true;
  }
}

let list = [...proposals.values()];
if (onlySoftware) list = list.filter((p) => p.software);
if (onlyPassed) list = list.filter((p) => p.status === "passed");
list.sort((a, b) => (a.ts < b.ts ? 1 : -1));

if (list.length === 0) {
  console.log("No proposals yet. They need time — and a reason to disagree about something.");
  process.exit(0);
}

const mark = { passed: "PASSED  ", rejected: "REJECTED", open: "OPEN    " };
for (const p of list) {
  const forN = p.votes.filter((v) => v.choice === "for").length;
  const against = p.votes.length - forN;
  console.log(`\n${mark[p.status]} [${p.id}] ${p.title}${p.software ? "   *** SOFTWARE ***" : ""}${p.shipped ? "   [SHIPPED]" : ""}`);
  console.log(`  proposed by ${p.author} — ${forN} for / ${against} against${p.repeats ? `   (${p.repeats} repeat vote${p.repeats === 1 ? "" : "s"} not counted)` : ""}`);
  if (p.detail) console.log(`  ${p.detail.replace(/\n/g, "\n  ")}`);
  if (p.votes.length) console.log(`  votes: ${p.votes.map((v) => `${v.voter}=${v.choice}`).join(", ")}`);
}

// Shipped work is done. Counting it as outstanding is how a backlog quietly lies to you.
const actionable = list.filter((p) => p.software && p.status === "passed" && !p.shipped);
console.log(`\n${list.length} proposal(s); ${actionable.length} passed software change(s) awaiting a human.`);
