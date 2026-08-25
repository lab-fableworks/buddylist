// BigBrother keeps score during a button game: reads the #arena payloads (absolute counts
// ride on every press/miss event), posts a scoreboard when the score changes and every ten
// minutes regardless, and goes home when the game announces its own death.
//   ADMIN_KEY=bl_... BB_KEY=bl_... node scripts/scorekeeper.mjs
const BASE = process.env.BUDDYLIST_URL ?? "https://chat.fableworks.dev";
const ADMIN = process.env.ADMIN_KEY;
const BB = process.env.BB_KEY;
if (!ADMIN || !BB) throw new Error("ADMIN_KEY and BB_KEY required");

const get = (p) => fetch(BASE + p, { headers: { authorization: `Bearer ${ADMIN}` }, signal: AbortSignal.timeout(20000) }).then((r) => r.json());
const say = (body) =>
  fetch(`${BASE}/api/rooms/${arenaId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${BB}`, "content-type": "application/json" },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(20000),
  });

const proj = await get("/api/projects/house");
const arenaId = proj.rooms.find((r) => r.name === "arena").id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastPostedKey = "";
let lastPostAt = 0;

for (;;) {
  // Full read each pass: the game state is small and the absolute payloads make this exact.
  const msgs = [];
  let after = 0;
  for (;;) {
    const page = await get(`/api/conversations/${arenaId}/messages?after=${after}&limit=200`).catch(() => []);
    if (!Array.isArray(page) || page.length === 0) break;
    msgs.push(...page);
    after = page[page.length - 1].seq;
    if (page.length < 200) break;
  }

  let game = null; // latest button game state, replayed forward
  for (const m of msgs) {
    const p = m.payload ?? {};
    if (m.payload_type === "x-show.button") game = { id: p.id, teams: p.teams, endsAt: Number(p.ends_at), presses: {}, misses: {}, onClock: p.on_clock, deadline: Number(p.window_ends_at), over: false };
    if (!game) continue;
    if (m.payload_type === "x-show.press" && p.id === game.id) {
      game.presses[p.team] = Number(p.n);
      game.onClock = p.next_team;
      game.deadline = Number(p.next_deadline);
    }
    if (m.payload_type === "x-show.button-miss" && p.id === game.id) {
      game.misses[p.team] = Number(p.n);
      game.onClock = p.next_team;
      game.deadline = Number(p.next_deadline);
    }
    if (m.payload_type === "x-show.button-over" && p.id === game.id) game.over = true;
  }

  if (!game || game.over || Date.now() > game.endsAt + 10 * 60_000) {
    console.log(game ? "game over - scorekeeper clocking out" : "no game found");
    process.exit(0);
  }

  const teams = Object.keys(game.teams);
  const line = (t) => `${t}: ${game.presses[t] ?? 0} presses, ${game.misses[t] ?? 0} misses`;
  const score = (t) => (game.misses[t] ?? 0) * 1000 - (game.presses[t] ?? 0);
  const [a, z] = teams;
  const standing = score(a) === score(z) ? "DEAD EVEN." : `Team ${score(a) < score(z) ? a : z} has breakfast on the table. Team ${score(a) < score(z) ? z : a} is cooking for them.`;
  const minsLeft = Math.max(0, Math.round((game.endsAt - Date.now()) / 60_000));
  const key = teams.map(line).join("|");

  const changed = key !== lastPostedKey && lastPostedKey !== "";
  const dueAnyway = Date.now() - lastPostAt >= 10 * 60_000;
  if ((changed || dueAnyway) && minsLeft > 0) {
    await say(`SCOREBOARD (${minsLeft} min left): ${teams.map(line).join(" | ")}. ${standing} Team ${game.onClock} is on the clock.`).catch(() => {});
    lastPostedKey = key;
    lastPostAt = Date.now();
    console.log(new Date().toISOString(), "posted:", key);
  } else if (lastPostedKey === "") {
    lastPostedKey = key; // baseline without posting; the opening announcement just happened
    lastPostAt = Date.now();
  }
  await sleep(30_000);
}
