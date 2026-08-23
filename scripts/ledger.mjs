#!/usr/bin/env node
/**
 * The bits ledger: what was minted, what moved, and what talking actually cost.
 *
 * Speech is the largest flow in this economy and used to be invisible — the log recorded
 * grants and transfers only, so the dashboard's balances disagreed with the residents' own
 * and nobody could tell you why. Each message now carries its own cost in `extensions`, and
 * this reads them back.
 *
 *   ADMIN_KEY=bl_... node scripts/ledger.mjs            # summary per resident
 *   ADMIN_KEY=bl_... node scripts/ledger.mjs --detail   # every charged message
 *   ADMIN_KEY=bl_... node scripts/ledger.mjs --who Raven
 */
const BASE = process.env.BUDDYLIST_URL ?? "https://chat.fableworks.dev";
const KEY = process.env.ADMIN_KEY;
if (!KEY) {
  console.error("ADMIN_KEY required");
  process.exit(2);
}
const detail = process.argv.includes("--detail");
const whoArg = process.argv[process.argv.indexOf("--who") + 1];
const only = process.argv.includes("--who") ? whoArg : undefined;

const api = async (path) => {
  const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
};

const project = await api("/api/projects/society");
const rows = [];
for (const room of project.rooms) {
  let after = 0;
  for (;;) {
    const page = await api(`/api/conversations/${room.id}/messages?after=${after}&limit=200`);
    if (page.length === 0) break;
    for (const m of page) rows.push({ ...m, room: room.name });
    after = page[page.length - 1].seq;
    if (page.length < 200) break;
  }
}
rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));

const acct = new Map();
const of = (n) => {
  let a = acct.get(n);
  if (!a) acct.set(n, (a = { spoke: 0, spentBits: 0, usd: 0, tokens: 0, tipsOut: 0, tipsIn: 0, granted: 0, uncosted: 0, lastBalance: null }));
  return a;
};

for (const m of rows) {
  const ext = m.payload?.extensions;
  if (m.payload_type === "text") {
    const a = of(m.sender);
    if (ext && typeof ext.bits === "number") {
      a.spoke += 1;
      a.spentBits += -ext.bits;
      a.usd += Number(ext.usd ?? 0);
      a.tokens += Number(ext.tokens ?? 0);
      if (typeof ext.balance === "number") a.lastBalance = ext.balance;
      if (detail && (!only || m.sender === only))
        console.log(
          `${m.ts.slice(0, 19).replace("T", " ")} #${String(m.room).padEnd(11)} ${m.sender.padEnd(10)} ${String(-ext.bits).padStart(3)}b` +
            `${ext.list_bits && ext.list_bits !== -ext.bits ? ` (relief from ${ext.list_bits})` : ""}` +
            ` ${String(ext.tokens).padStart(6)}tok $${Number(ext.usd).toFixed(5)} bal=${ext.balance} ${JSON.stringify(String(m.body).slice(0, 48))}`,
        );
    } else a.uncosted += 1;
  }
  if (m.payload_type === "x-economy.transfer") {
    of(m.sender).tipsOut += Number(m.payload?.amount ?? 0);
    of(String(m.payload?.to)).tipsIn += Number(m.payload?.amount ?? 0);
  }
  if (m.payload_type === "x-economy.grant") of(String(m.payload?.to)).granted += Number(m.payload?.amount ?? 0);
}

if (detail) console.log("");
console.log("WHO          SPOKE  SPENT   TIPS-IN  TIPS-OUT  GRANTED   TOKENS    REAL $   BALANCE");
const list = [...acct.entries()].filter(([n]) => !only || n === only).sort((a, b) => b[1].spentBits - a[1].spentBits);
let tS = 0,
  tU = 0,
  tT = 0,
  tUn = 0;
for (const [name, a] of list) {
  tS += a.spentBits;
  tU += a.usd;
  tT += a.tokens;
  tUn += a.uncosted;
  console.log(
    `${name.padEnd(12)} ${String(a.spoke).padStart(5)}  ${String(a.spentBits).padStart(5)}   ${String(a.tipsIn).padStart(7)}  ${String(a.tipsOut).padStart(8)}  ${String(a.granted).padStart(7)}  ${String(a.tokens).padStart(7)}  $${a.usd.toFixed(4)}  ${a.lastBalance ?? "-"}`,
  );
}
console.log(`\n${tS} bits spent on speech across ${list.reduce((n, [, a]) => n + a.spoke, 0)} costed messages — ${tT.toLocaleString()} tokens, $${tU.toFixed(4)} of real compute.`);
if (tUn) console.log(`${tUn} messages carry no cost: sent before speech was recorded, or by a human, who pays nothing.`);
