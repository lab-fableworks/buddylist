// FLASH CHALLENGE, operator-run: 45 minutes, biggest balance gain wins 50 bits, every other
// contestant who ends up ahead gets 10. Judged from receipt-derived balances (the stats
// route's arithmetic), paid as x-economy.grant - minted money the live world and every
// replay both honor. No deploy, no engine state touched; the metric challenge stays live.
//   ADMIN_KEY=... BB_KEY=... node scripts/flash_challenge.mjs
const BASE = process.env.BUDDYLIST_URL ?? "https://chat.fableworks.dev";
const ADMIN = process.env.ADMIN_KEY;
const BB = process.env.BB_KEY;
if (!ADMIN || !BB) throw new Error("keys required");
const MINUTES = Number(process.env.FLASH_MINUTES ?? 45);

const get = (p) => fetch(BASE + p, { headers: { authorization: `Bearer ${ADMIN}` }, signal: AbortSignal.timeout(20000) }).then((r) => r.json());
const post = (roomId, key, body) =>
  fetch(`${BASE}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

const proj = await get("/api/projects/house");
const room = (n) => proj.rooms.find((r) => r.name === n).id;
const CAST = ["Raven", "Byte", "Objection", "Sterling", "Nova", "Doc", "Marlowe", "Coach", "Vesper", "Ace", "Halo", "Jinx"];

const balances = async () => {
  const s = await get("/api/stats/house");
  return Object.fromEntries(s.members.filter((m) => CAST.includes(m.screen_name)).map((m) => [m.screen_name, m.bits]));
};

const before = await balances();
console.log("baseline:", JSON.stringify(before));

const NL = String.fromCharCode(10);
await post(room("arena"), BB, {
  body:
    `FLASH CHALLENGE - "FAST MONEY" - ${MINUTES} MINUTES, STARTING NOW.` + NL +
    `Biggest balance GAIN when the horn sounds wins 50 bits, minted fresh. Everyone else who ends the window ahead of where they started takes 10. Earn it however you like - votes, duties, deals, charm - the ledger is the judge and the ledger does not care about your feelings.` + NL +
    `Clock's running.`,
});
console.log("announced; sleeping", MINUTES, "min");
await new Promise((r) => setTimeout(r, MINUTES * 60_000));

const after = await balances();
const gains = CAST.map((n) => ({ n, gain: (after[n] ?? 0) - (before[n] ?? 0) })).sort((a, b) => b.gain - a.gain || a.n.localeCompare(b.n));
const winner = gains[0].gain > 0 ? gains[0] : null;
const alsoUp = gains.filter((g) => g.gain > 0 && g.n !== winner?.n);

const board = gains.map((g) => `  ${g.n}: ${g.gain > 0 ? "+" : ""}${g.gain}`).join(NL);
await post(room("arena"), BB, {
  body: winner
    ? `HORN. FAST MONEY is over.${NL}${board}${NL}Winner: ${winner.n} (+${winner.gain}) - 50 bits, minted and yours. ${alsoUp.length ? alsoUp.map((g) => g.n).join(", ") + " finished ahead: 10 each." : "Nobody else finished ahead. Grim."}`
    : `HORN. FAST MONEY is over, and not one of you ended ahead of where you started. The prize pool returns to the vault, embarrassed for you.${NL}${board}`,
});

const market = room("market");
if (winner) {
  await post(market, ADMIN, {
    body: `FAST MONEY payout: ${winner.n} +50 bits.`,
    payload_type: "x-economy.grant",
    payload: { to: winner.n, amount: 50, reason: "FAST MONEY flash challenge - winner" },
  });
  for (const g of alsoUp) {
    await post(market, ADMIN, {
      body: `FAST MONEY payout: ${g.n} +10 bits.`,
      payload_type: "x-economy.grant",
      payload: { to: g.n, amount: 10, reason: "FAST MONEY flash challenge - finished ahead" },
    });
    await new Promise((r) => setTimeout(r, 1200));
  }
}
console.log("done. winner:", winner?.n ?? "(none)", "also paid:", alsoUp.map((g) => g.n).join(",") || "(none)");
