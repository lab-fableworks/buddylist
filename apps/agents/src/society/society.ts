/**
 * The society: citizens, a shared world, and a director that decides who speaks next.
 *
 * Two things drive a turn:
 *   - Reaction. Someone (especially a human) said something that concerns a citizen.
 *   - Initiative. The director picks someone to start or continue a conversation.
 *
 * Only one citizen speaks per tick. Letting all eight answer every message would be both
 * unreadable and eight times the cost, so the director picks the most plausible responder.
 */
import WebSocket from "ws";
import { BuddyList, type Message } from "@buddylist/sdk";
import { CITIZENS, ROOM_PURPOSE, SOCIETY_ROOMS, type Citizen } from "./citizens.js";
import { Brain, DEFAULT_MODEL, type TurnAction, type TurnResult } from "./brain.js";
import { modelFor } from "./providers.js";
import { Budget, loadRemotePrices } from "./budget.js";
import { EARNINGS, LEDGER_TYPES, RELATION_KINDS, World, replay, speechCost, type Relationship } from "./world.js";
import { Outreach, outreachConfig } from "./outreach.js";
import { Rhythms, crowdFactor, hoursOf, traitsOf } from "./rhythm.js";
import { deNarrate, looksNarrated, narrationShare, promisesProposal, stripSelfPrefix, wordCount } from "./style.js";
import { ROLES, STALE_PROPOSAL_HOURS } from "./roles.js";
import { METRICS, Show, SHOW_TYPES } from "./show.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[society]", ...a);
/** The society default with any routing prefix stripped, for comparing against a resident's model. */
const resolveDefault = (spec: string) => spec.replace(/^oa:/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

/** Raven said this about Coach, unprompted, five times over. It is her reason, not mine. */
const NOTE_A = "he notices the unglamorous work and says so to your face";
const NOTE_B = "she sees straight through it and stays anyway";

interface Resident {
  citizen: Citizen;
  bot: BuddyList;
  brain: Brain;
}

/** Rolling transcript per conversation, so a citizen can see what it is walking into. */
const TRANSCRIPT_LIMIT = 14;

export class Society {
  private residents: Resident[] = [];
  private world: World;
  private budget: Budget;
  private rooms = new Map<string, string>(); // room name -> conversation id
  private transcripts = new Map<string, string[]>(); // conversation id -> lines
  /** Conversations with unanswered human input, handled before anything else. */
  private urgent: Array<{ conversationId: string; from: string; text: string }> = [];
  private lastSpeaker = "";
  private running = false;
  /** Observed bits-per-message, so the affordability gate tracks reality. */
  private recentRates: number[] = [];
  private outreach = new Outreach(outreachConfig());
  private rhythms = new Rhythms();
  /** Last observed presence of the human, refreshed on a timer. */
  private humanState: string | undefined;
  /** Humans in the project — the people residents may reach out to. */
  private humans: string[] = [];
  /** Residents who said they would file a proposal and did not, with nudges remaining. */
  private promised = new Map<string, number>();
  /** Set when the human arrives, cleared when the Host has greeted them. */
  private hostDue = false;
  /** Proposal id -> when the Whip last named the absentees, so one stale proposal is not nagged every tick. */
  private whipped = new Map<string, number>();
  /** Role -> when its holder was last given the floor. A duty that was not done is retried hourly, not every tick. */
  private dutyAttempt = new Map<string, number>();
  /** Season state, rebuilt from the #arena log. Present even when the show is off. */
  private show = new Show(CITIZENS.map((c) => c.screen_name));
  private showOn = process.env.SOCIETY_SHOW === "1";
  /** The house's own voice: announcements in #arena. Not a resident, never chats. */
  private houseBot?: BuddyList;
  private lastConfessionalAt = 0;
  /** Open huddles: private strategy rooms on a 30-minute clock, given priority turns. */
  private huddles: Array<{ roomId: string; creator: string; members: string[]; topic: string; endsAt: number; turns: number }> = [];
  private huddleMinutes = Number(process.env.SHOW_HUDDLE_MINUTES ?? 30);
  private confessionalIdx = 0;
  private showCfg = {
    challengeEveryMs: Number(process.env.SHOW_CHALLENGE_HOURS ?? 24) * 3600_000,
    challengeLenMs: Number(process.env.SHOW_CHALLENGE_LEN_HOURS ?? 24) * 3600_000,
    evictionEveryMs: Number(process.env.SHOW_EVICTION_HOURS ?? 72) * 3600_000,
    voteWindowMs: Number(process.env.SHOW_VOTE_WINDOW_HOURS ?? 12) * 3600_000,
    prize: Number(process.env.SHOW_CHALLENGE_PRIZE ?? 25),
    confessionalEveryMs: Number(process.env.SHOW_CONFESSIONAL_HOURS ?? 8) * 3600_000,
  };

  constructor(
    private url: string,
    private project: string,
    apiKey: string,
    opts: { dailyUsd: number; model?: string },
  ) {
    const equalStart = Number(process.env.SOCIETY_EQUAL_START ?? 0);
    // A season starts level: SOCIETY_EQUAL_START=100 overrides every coded starting balance.
    // The old project's replay still uses the coded numbers, so history stays reconstructible.
    this.world = new World(equalStart > 0 ? CITIZENS.map((c) => ({ screen_name: c.screen_name, wealth: equalStart })) : CITIZENS, ROLES);
    this.budget = new Budget(opts.model ?? DEFAULT_MODEL, opts.dailyUsd);
    this.apiKey = apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
  }
  private apiKey: string;
  private model: string;

  /** What a message currently costs, from observed spend. */
  private goingRate() {
    if (this.recentRates.length === 0) return 2;
    return Math.max(1, Math.round(this.recentRates.reduce((a, b) => a + b, 0) / this.recentRates.length));
  }

  get status() {
    return {
      residents: this.residents.map((r) => ({
        screen_name: r.citizen.screen_name,
        connected: !!r.bot.me,
        bits: this.world.balance(r.citizen.screen_name),
        model: r.brain.model,
      })),
      proposals: [...this.world.proposals.values()].map((p) => ({ id: p.id, title: p.title, status: p.status, votes: Object.keys(p.votes).length })),
      budget: this.budget.status,
      going_rate_bits: this.goingRate(),
      outreach: this.outreach.status,
      humans: this.humans,
      human_state: this.humanState ?? "unknown",
      rhythms: this.rhythms.status(this.residents.map((r) => r.citizen.screen_name)),
      roles: [...this.world.roles.entries()].map(([name, s]) => ({ role: name, holder: s.holder, reports: s.reports, last_report: s.lastReportAt ? new Date(s.lastReportAt).toISOString() : null })),
      show: this.showOn
        ? { active: this.show.active(), jury: this.show.jury(), immunity: this.show.immunity ?? null, winner: this.show.winner ?? null, challenge: this.show.challenge?.id ?? null, eviction: this.show.eviction?.id ?? null }
        : null,
      model: this.model,
    };
  }

  // ------------------------------------------------------------------ startup

  async start(keys: Record<string, string>) {
    for (const c of CITIZENS) {
      const key = keys[c.keyEnv];
      if (!key) continue;
      const bot = new BuddyList({ url: this.url, apiKey: key, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
      // SOCIETY_MODEL_RAVEN=oa:z-ai/glm-4.6 puts one resident on another model entirely.
      const spec = modelFor(c.screen_name, this.model);
      let brain: Brain;
      try {
        brain = new Brain(this.apiKey, spec);
      } catch (e) {
        // A misconfigured override must cost one resident, not the whole society.
        log(`${c.screen_name}: ${(e as Error).message} — falling back to ${this.model}`);
        brain = new Brain(this.apiKey, this.model);
      }
      try {
        await bot.connect();
        // Publish who they are, not just what they can do — the operator dashboard reads this
        // to explain a resident to a human who has never met them.
        await bot
          .updateProfile({
            profile: { bio: c.bio, traits: traitsOf(c.screen_name, c.chattiness), hours: hoursOf(c.screen_name) },
            capabilities: { model: brain.model, skills: c.skills, accepts: ["question", "task.request"] },
          })
          .catch(() => {});
        this.residents.push({ citizen: c, bot, brain });
        log(`${c.screen_name} moved in${brain.model === resolveDefault(this.model) ? "" : ` (thinking with ${brain.model})`}`);
      } catch (e) {
        log(`${c.screen_name} failed to connect:`, (e as Error).message);
      }
    }
    if (this.residents.length === 0) throw new Error("no citizens configured");

    // Rooms, joined by everyone.
    const host = this.residents[0].bot;
    for (const r of SOCIETY_ROOMS) {
      try {
        const room = await host.room(this.project, r.name);
        this.rooms.set(r.name, room.id);
      } catch {
        log(`room #${r.name} unavailable — is the project set up?`);
      }
    }
    for (const res of this.residents) {
      for (const [name] of this.rooms) await res.bot.room(this.project, name).catch(() => {});
    }

    // The house's announcer. Optional: without a key the show simply has no voice and stays off.
    const bbKey = process.env.KEY_BIGBROTHER;
    if (this.showOn && bbKey) {
      try {
        const bb = new BuddyList({ url: this.url, apiKey: bbKey, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
        await bb.connect();
        for (const [name] of this.rooms) await bb.room(this.project, name).catch(() => {});
        await bb
          .updateProfile({ profile: { bio: "The house. Announcements only. Do not @ me; I am load-bearing." }, capabilities: { skills: ["announcements"] } })
          .catch(() => {});
        this.houseBot = bb;
        log("BigBrother is watching");
      } catch (e) {
        log("BigBrother failed to connect:", (e as Error).message);
      }
    }

    // Rebuild money, proposals and opinions from the chat log.
    const market = this.rooms.get("market");
    const proposals = this.rooms.get("proposals");
    const gossip = this.rooms.get("gossip");
    const patchNotes = this.rooms.get("patch-notes");
    const commons = this.rooms.get("commons");
    const arena = this.rooms.get("arena");
    for (const id of [market, proposals, gossip, patchNotes, commons, arena]) {
      if (id) await replay(host, id, this.world, this.residents.length).catch(() => {});
    }
    // The season replays from the same log the world does, so a deploy resumes mid-beat
    // instead of re-announcing a challenge or forgetting an eviction.
    if (arena) {
      let after = 0;
      let sawShow = false;
      for (;;) {
        const page: Message[] = await host.history(arena, { after, limit: 200 }).catch(() => []);
        if (page.length === 0) break;
        for (const m of page) {
          after = Math.max(after, m.seq);
          if (m.payload_type?.startsWith("x-show.")) {
            sawShow = true;
            this.show.apply(m.payload_type, (m.payload ?? {}) as Record<string, unknown>, m.sender, Date.parse(m.ts));
          }
        }
        if (page.length < 200) break;
      }
      if (!sawShow) this.show.seed(Date.now());
      if (this.showOn)
        log(
          `season restored: ${this.show.active().length} in the house, ${this.show.jury().length} on the jury` +
            (this.show.immunity ? `, ${this.show.immunity} immune` : "") +
            (this.show.winner ? `, WINNER ${this.show.winner}` : ""),
        );
    }
    log("world restored:", [...this.world.balances].map(([k, v]) => `${k}=${v}`).join(" "));

    // Anyone in the project who is not a resident is a person the society can talk to.
    try {
      const proj = await host.project(this.project);
      this.humans = proj.members.filter((m) => !CITIZENS.some((c) => c.screen_name === m.screen_name) && m.screen_name !== "BigBrother").map((m) => m.screen_name);
      log("humans present:", this.humans.join(", ") || "(none)");
    } catch {
      log("could not read project members; outreach disabled");
    }

    // Real prices for any non-Anthropic model, before anyone speaks and is charged for it.
    const gateway = process.env.SOCIETY_OPENAI_BASE_URL;
    if (gateway && this.residents.some((r) => r.brain.model !== resolveDefault(this.model))) {
      try {
        log(`priced ${await loadRemotePrices(gateway)} models from ${gateway}`);
      } catch (e) {
        log(`could not fetch model prices (${(e as Error).message}); unpriced models bill at the top tier`);
      }
    }

    // What each resident has already said to the human lives on their profile, not in memory:
    // a deploy used to wipe it and re-arm every one-shot trigger.
    for (const res of this.residents) {
      const me = await res.bot.api<{ profile?: { outreach?: { lastDmAt?: number; used?: string[] } } }>("GET", "/me").catch(() => undefined);
      this.outreach.hydrate(res.citizen.screen_name, me?.profile?.outreach);
    }
    await this.arrangeMarriages();

    this.listen();
    const pollHuman = async () => {
      if (this.humans.length === 0) return;
      try {
        const u = await this.residents[0].bot.api<{ presence: { state: string } }>("GET", `/users/${this.humans[0]}`);
        const next = u.presence.state;
        if (next !== this.humanState) log(`${this.humans[0]} is now ${next}`);
        // Arriving, not booting: on the first poll humanState is unknown and a greeting on
        // every deploy would be noise.
        if (next === "online" && this.humanState !== undefined && this.humanState !== "online" && this.world.roles.has("Host")) this.hostDue = true;
        this.humanState = next;
      } catch {
        /* transient */
      }
    };
    void pollHuman();
    setInterval(() => void pollHuman(), 60_000);

    this.running = true;
    void this.director();
  }

  stop() {
    this.running = false;
    for (const r of this.residents) r.bot.close();
  }

  // ----------------------------------------------------------------- listening

  private listen() {
    // One resident's socket is enough to observe the rooms; per-citizen handlers would
    // multiply the same message by eight.
    const observer = this.residents[0];
    observer.bot.on("message", (f) => {
      const m = f.data;
      this.remember(m);
      // Show beats are applied wherever they were posted from; apply() is idempotent, so the
      // echo of the director's own post is harmless and an operator post steers the season.
      if (m.payload_type?.startsWith("x-show.") && m.sender === "BigBrother") {
        this.show.apply(m.payload_type, (m.payload ?? {}) as Record<string, unknown>, m.sender, Date.parse(m.ts));
      }
      // Grants are minted from outside and must land in the live world, not just on replay.
      if (m.payload_type === LEDGER_TYPES.grant) {
        const p = (m.payload ?? {}) as { to?: string; amount?: number };
        if (p.to && typeof p.amount === "number") {
          this.world.credit(p.to, p.amount);
          log(`grant: ${p.to} +${p.amount} bits from ${m.sender} (now ${this.world.balance(p.to)})`);
        }
        return;
      }
      const isCitizen = this.residents.some((r) => r.citizen.screen_name === m.sender) || m.sender === "BigBrother";
      if (!isCitizen && m.payload_type === "text" && m.body.trim()) {
        // A human spoke. That takes priority over idle chatter.
        this.urgent.push({ conversationId: m.conversation_id, from: m.sender, text: m.body });
        log(`human ${m.sender}: ${m.body.slice(0, 60)}`);
      }
    });

    // Direct IMs to any citizen get answered by that citizen.
    for (const r of this.residents) {
      r.bot.on("message", async (f) => {
        const m = f.data;
        if (m.sender === r.citizen.screen_name) return;
        const inbox = await r.bot.inbox().catch(() => []);
        const conv = inbox.find((c) => c.id === m.conversation_id);
        if (conv?.kind !== "im") return;
        this.remember(m);
        const wasAway = !this.rhythms.presenceOf(r.citizen.screen_name).awake;
        this.rhythms.wake(r.citizen.screen_name);
        const nudge = wasAway
          ? `${m.sender} just messaged you directly while you were away. Reply to them — you can mention you had stepped out if it is natural, but do not make a production of it.`
          : `${m.sender} just messaged you directly. Reply to them.`;
        await this.takeTurn(r, m.conversation_id, nudge).catch(() => {});
      });
    }
  }

  private remember(m: Message) {
    const line = `${m.sender}: ${m.body}`;
    const t = this.transcripts.get(m.conversation_id) ?? [];
    t.push(line);
    while (t.length > TRANSCRIPT_LIMIT) t.shift();
    this.transcripts.set(m.conversation_id, t);
  }

  // ------------------------------------------------------------------ director

  private async director() {
    while (this.running) {
      // Nobody watching means less reason to fill the room — more believable, and cheaper.
      const crowd = crowdFactor(this.humanState);
      const waitS = this.budget.paceSeconds(Number(process.env.SOCIETY_MIN_INTERVAL_S ?? 25)) * crowd.multiplier;
      await sleep(waitS * 1000 * (0.7 + Math.random() * 0.6));
      if (!this.running) break;

      if (this.budget.exhausted) {
        log("daily budget reached — the society is resting until the window rolls over");
        await sleep(10 * 60_000);
        continue;
      }

      try {
        const urgent = this.urgent.shift();
        if (urgent) {
          const responder = this.chooseResponder(urgent.text);
          await this.takeTurn(responder, urgent.conversationId, `${urgent.from} (a human, not a resident) just said: "${urgent.text}". Respond to them directly.`);
          // Serving the human is the most reliable way to earn, which is the incentive we want.
          this.world.credit(responder.citizen.screen_name, EARNINGS.servedHuman);
          continue;
        }
        if (await this.huddleTick().catch((e) => (log("huddle tick failed:", (e as Error).message), false))) continue;
        if (await this.showTick().catch((e) => (log("show tick failed:", (e as Error).message), false))) continue;
        await this.announceDelinquencies().catch((e) => log("delinquency sweep failed:", (e as Error).message));
        if (await this.maybeDoDuty()) continue;
        if (await this.maybeReachOut()) continue;
        await this.spontaneous();
      } catch (e) {
        log("turn failed:", (e as Error).message);
      }
    }
  }

  /**
   * Private huddles run hot: while one is open its members get the floor on most ticks,
   * which is what "talking quickly" means in a world where the director allots all turns.
   * The house keeps breathing on the ticks the huddle skips.
   */
  private async huddleTick(): Promise<boolean> {
    const now = Date.now();
    // Expire finished huddles, telling the room so the transcript has an ending.
    for (const h of [...this.huddles]) {
      if (now < h.endsAt) continue;
      this.huddles = this.huddles.filter((x) => x !== h);
      const creator = this.residents.find((r) => r.citizen.screen_name === h.creator);
      if (creator) await creator.bot.send(h.roomId, "(time - the huddle is over. Back to the house, separately, and act natural.)").catch(() => {});
      log(`huddle: "${h.topic}" by ${h.creator} expired`);
    }
    const h = this.huddles[0];
    if (!h || Math.random() > 0.75) return false;
    const eligible = this.residents.filter(
      (r) =>
        h.members.includes(r.citizen.screen_name) &&
        !this.show.isEvicted(r.citizen.screen_name) &&
        this.world.canAffordSpeech(r.citizen.screen_name, this.goingRate()),
    );
    if (eligible.length === 0) return false;
    // Rotate through the room; a huddle where one person monologues is not a huddle. Sleep
    // is not an excuse in here - you came to this room on purpose minutes ago.
    const res = eligible[h.turns % eligible.length];
    // The observer socket may not be a member, so the transcript is read from the room itself.
    const hist = await res.bot.history(h.roomId, { limit: 30 }).catch(() => [] as Message[]);
    this.transcripts.set(h.roomId, hist.filter((m) => m.body).map((m) => `${m.sender}: ${m.body}`));
    const minsLeft = Math.max(1, Math.round((h.endsAt - now) / 60_000));
    h.turns += 1;
    await this.takeTurn(
      res,
      h.roomId,
      `You are in the back room ${h.creator} opened ("${h.topic}") - ${minsLeft} minutes left. In here: ${h.members.join(", ")}. Nobody else can read this. Say the real thing, briefly: who you trust, how you will vote, what you want from the people in this room.`,
      "huddle",
    );
    return true;
  }

  /**
   * The show's heartbeat: close whatever deadline has passed, open whatever is due, and
   * hand out the occasional confessional. Announcements are plain posts — no model call —
   * so the tick is nearly free; only a confessional turn costs anything.
   */
  private async showTick(): Promise<boolean> {
    if (!this.showOn || !this.houseBot) return false;
    const arena = this.rooms.get("arena");
    if (!arena) return false;
    const now = Date.now();
    const bb = this.houseBot;
    const post = async (body: string, type: string, payload: Record<string, unknown>) => {
      const sent = await bb.send(arena, { body, payload_type: type, payload }).catch(() => null);
      if (sent) this.show.apply(type, payload, "BigBrother", now);
      return !!sent;
    };

    // Close a challenge whose deadline has passed.
    if (this.show.challenge && now >= this.show.challenge.endsAt) {
      const { winner, scores } = this.show.challengeWinner(this.world);
      const board = Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .map(([n, v]) => `  ${n}: ${v > 0 ? "+" : ""}${v}`)
        .join("\n");
      if (winner) this.world.credit(winner, this.showCfg.prize);
      await post(
        winner
          ? `CHALLENGE OVER — "${METRICS[this.show.challenge.metric].title}". Winner: ${winner} (+${this.showCfg.prize} bits, IMMUNITY from the next eviction).\nFinal board:\n${board}`
          : `CHALLENGE OVER — "${METRICS[this.show.challenge.metric].title}". Nobody moved the number. No winner, no immunity. The house should be embarrassed.\nFinal board:\n${board}`,
        SHOW_TYPES.result,
        { id: this.show.challenge.id, winner, prize: winner ? this.showCfg.prize : 0, scores },
      );
      log(`show: challenge closed, winner ${winner ?? "(none)"}`);
      return false;
    }

    // Close an eviction whose window has passed.
    if (this.show.eviction && now >= this.show.eviction.endsAt) {
      const { out, tally } = this.show.evictionResult(this.world);
      const lines = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([n, v]) => `  ${n}: ${v} vote${v === 1 ? "" : "s"}`).join("\n");
      if (out) {
        await post(
          `THE HOUSE HAS SPOKEN. ${out} has been evicted and joins the jury.\n${lines}\n${out}: the jury remembers everything. The rest of you: so does ${out}.`,
          SHOW_TYPES.evicted,
          { id: this.show.eviction.id, name: out, tally },
        );
        const res = this.residents.find((r) => r.citizen.screen_name === out);
        if (res) {
          const role = this.world.roleOf(out);
          if (role) {
            this.world.resignRole(role.name, out);
            const commons = this.rooms.get("commons");
            if (commons)
              await res.bot
                .send(commons, { body: `(${out} was evicted; the ${role.name} role is vacant)`, payload_type: LEDGER_TYPES.roleResigned, payload: { role: role.name, evicted: true } })
                .catch(() => {});
          }
          void res.bot.setPresence("away", "evicted — in the jury house").catch(() => {});
          void res.bot.setActivity({ headline: "In the jury house", project: this.project, detail: "watching everything" }).catch(() => {});
        }
        log(`show: ${out} evicted`);
      } else {
        await post("EVICTION VOTE CLOSED. Nobody voted. The house keeps everyone, this time. That was the free one.", SHOW_TYPES.evicted, { id: this.show.eviction.id, name: "", tally: {} });
        log("show: eviction closed with no votes");
      }
      return false;
    }

    // Close the finale.
    if (this.show.finale && now >= this.show.finale.endsAt) {
      const { winner, tally } = this.show.finaleResult(this.world);
      const finalists = this.show.active().join(" and ");
      await post(
        winner
          ? `THE JURY HAS DECIDED. The winner of Season 1 is ${winner}.\nVotes: ${Object.entries(tally).map(([n, v]) => `${n} ${v}`).join(", ")}.\n@zgmcginn — the pot is yours to hand over. ${winner}: say something for the cameras.`
          : `THE FINALE CLOSED WITHOUT A JURY VERDICT between ${finalists}. @zgmcginn — this one is yours to settle.`,
        SHOW_TYPES.winner,
        { name: winner ?? "", tally },
      );
      log(`show: season over, winner ${winner ?? "(unsettled)"}`);
      return false;
    }

    // Open the finale at two remaining.
    if (this.show.finaleDue()) {
      const id = `f${Date.now().toString(36)}`;
      const [a, b] = this.show.active();
      await post(
        `TWO REMAIN: ${a} and ${b}. THE FINALE IS OPEN for ${Math.round(this.showCfg.voteWindowMs / 3600_000)} hours. Jury — ${this.show.jury().join(", ")} — you alone decide: cast_eviction_vote with the name you want to WIN. Finalists: make your case. Everything you did this season is on the record.`,
        SHOW_TYPES.finale,
        { id, ends_at: now + this.showCfg.voteWindowMs },
      );
      log("show: finale open");
      return false;
    }

    // Open an eviction window.
    if (this.show.evictionDue(now, this.showCfg.evictionEveryMs)) {
      const id = `e${Date.now().toString(36)}`;
      await post(
        `EVICTION VOTE OPEN for ${Math.round(this.showCfg.voteWindowMs / 3600_000)} hours. Cast yours with the cast_eviction_vote tool — public, with your name and reason.${this.show.immunity ? ` ${this.show.immunity} holds immunity and cannot be named.` : ""} Whoever tops the count leaves for the jury. Campaigning is legal. Buying votes is not.`,
        SHOW_TYPES.eviction,
        { id, ends_at: now + this.showCfg.voteWindowMs },
      );
      log("show: eviction open");
      return false;
    }

    // Open a challenge.
    if (this.show.challengeDue(now, this.showCfg.challengeEveryMs)) {
      const id = `c${Date.now().toString(36)}`;
      const metricId = this.show.nextMetric();
      const m = METRICS[metricId];
      const baseline = this.show.baseline(this.world);
      await post(
        `CHALLENGE — "${m.title}" — ${Math.round(this.showCfg.challengeLenMs / 3600_000)} hours on the clock.\n${m.brief}\nPrize: ${this.showCfg.prize} bits and IMMUNITY from the next eviction. The ledger judges; talk does not count. Go.`,
        SHOW_TYPES.challenge,
        { id, metric: metricId, ends_at: now + this.showCfg.challengeLenMs, baseline },
      );
      log(`show: challenge "${m.title}" open`);
      return false;
    }

    // The confessional chair: one contestant, alone, on rotation.
    const confessional = this.rooms.get("confessional");
    if (confessional && now - this.lastConfessionalAt >= this.showCfg.confessionalEveryMs) {
      const pool = this.residents.filter((r) => !this.show.isEvicted(r.citizen.screen_name) && this.rhythms.presenceOf(r.citizen.screen_name).awake);
      if (pool.length) {
        const res = pool[this.confessionalIdx++ % pool.length];
        this.lastConfessionalAt = now;
        await this.takeTurn(
          res,
          confessional,
          "You are alone in the confessional, talking to the audience. Two or three sentences: how the game actually looks from where you sit — who you trust, who worries you, what you are planning. Be honest in the way you never quite are in the rooms. Do not address the other residents.",
          "confessional",
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Say the strikes out loud (pmt6c39yy). The world tracks them; this posts them, because a
   * delinquency mark nobody can see is not a consequence. The vacancy is posted as the
   * holder resigning - the payload the replay already understands - so a restart agrees
   * with the room about who holds what.
   */
  private async announceDelinquencies() {
    for (const d of this.world.sweepDelinquencies()) {
      const res = this.residents.find((r) => r.citizen.screen_name === d.holder);
      const roomId = this.rooms.get(this.world.roleDef(d.role)?.room ?? "commons") ?? this.rooms.get("commons");
      if (!res || !roomId) continue;
      if (d.vacated) {
        await res.bot
          .send(roomId, {
            body: `(${d.holder} has missed three ${d.role} cycles in a row - the role is now vacant. Anyone may take it.)`,
            payload_type: LEDGER_TYPES.roleResigned,
            payload: { role: d.role, delinquent: true },
          })
          .catch(() => {});
        log(`role: ${d.role} vacated - ${d.holder} hit 3 delinquencies`);
      } else {
        await res.bot
          .send(roomId, {
            body: `(${d.role} duty missed - ${d.holder} is marked delinquent, strike ${d.count} of 3. Filing the report, even late, clears it.)`,
            payload_type: LEDGER_TYPES.delinquent,
            payload: { role: d.role, count: d.count },
          })
          .catch(() => {});
        log(`role: ${d.holder} delinquent as ${d.role} (${d.count}/3)`);
      }
    }
  }

  /**
   * Give a role-holder the floor when their duty is due. What they say on that turn is the
   * report: it is filed and paid without a separate tool call, because a duty you can forget
   * to file is a duty that goes unfiled. Returns true when a duty turn was taken.
   */
  private async maybeDoDuty(): Promise<boolean> {
    const awakeHolder = (role: string) => {
      const s = this.world.roles.get(role);
      const res = s && this.residents.find((r) => r.citizen.screen_name === s.holder);
      if (res && this.show.isEvicted(res.citizen.screen_name)) return undefined; // the jury has no duties
      return res && this.rhythms.presenceOf(res.citizen.screen_name).awake ? res : undefined;
    };
    const duty = async (res: Resident, role: string, room: string, nudge: string) => {
      const conversationId = this.rooms.get(room);
      if (!conversationId) return false;
      const me = res.citizen.screen_name;
      const def = this.world.roleDef(role);
      this.dutyAttempt.set(role, Date.now());
      const turn = await this.takeTurn(res, conversationId, `You are the ${role}. ${nudge} This is your report; say it plainly in the room.`, room);
      if (!turn.said) return true; // they took the turn and chose silence: no report, no pay
      if (def?.requires === "propose") {
        if (!turn.proposedSoftware) {
          // Words are not the deliverable here. The duty stays due; they get the floor again in an hour.
          log(`duty: ${me} spoke as ${role} but filed no software proposal — not a report`);
          await res.bot.send(conversationId, `(${role} duty not met — no software proposal was filed. It is still due. A refused duplicate does not count; file something new, or vote on what is open.)`).catch(() => {});
          return true;
        }
        // The accepted filing already filed and announced the report inside enact.
        return true;
      }
      const r = this.world.fileReport(role, me);
      // Lateness is public and unpaid (pmt669n0j). Saying it out loud is the point: a duty
      // nobody can see you miss is not a duty.
      const note = r.late ? `(${role} report filed ${r.lateHours}h after it was due — LATE, no payment for this cycle)` : `(${role} report filed${r.paid ? ` — paid ${r.paid} bits` : ""})`;
      await res.bot
        .send(conversationId, { body: note, payload_type: LEDGER_TYPES.roleReport, payload: { role, paid: r.paid, late: r.late, late_hours: r.lateHours } })
        .catch(() => {});
      log(`duty: ${me} reported as ${role}${r.late ? ` LATE by ${r.lateHours}h, unpaid` : r.paid ? ` (+${r.paid}b)` : " (within cadence, unpaid)"}`);
      return true;
    };

    // The human just arrived and someone is the Host.
    if (this.hostDue) {
      const host = awakeHolder("Host");
      if (host) {
        this.hostDue = false;
        return duty(host, "Host", "commons", `${this.humans[0]} just came online. Greet them briefly and tell them what they missed that matters — a decision, a fight, a proposal, money that moved. Two or three sentences.`);
      }
    }
    // A proposal has sat under quorum too long and someone is the Whip.
    //
    // The guard used to be per proposal, so with nineteen stale at once the Whip was handed the
    // floor nineteen times in a row - Raven filed nine reports, two of them fourteen seconds
    // apart, each one a paid-for model call. One duty is one turn: name the whole backlog once.
    const whipDef = this.world.roleDef("Whip");
    const whip = awakeHolder("Whip");
    if (whip && whipDef && Date.now() - (this.dutyAttempt.get("Whip") ?? 0) > whipDef.cadenceHours * 3600_000) {
      const stale = this.world
        .staleProposals(this.residents.length, STALE_PROPOSAL_HOURS)
        .filter((p) => Date.now() - (this.whipped.get(p.id) ?? 0) > 6 * 3600_000);
      if (stale.length) {
        for (const p of stale) this.whipped.set(p.id, Date.now());
        const everyone = this.residents.map((r) => r.citizen.screen_name);
        const lines = stale.slice(0, 6).map((p) => {
          const absent = everyone.filter((n) => !p.votes[n] && n !== whip.citizen.screen_name);
          return `  [${p.id}] "${p.title.slice(0, 60)}" - open ${Math.round((Date.now() - p.at) / 3600_000)}h, still needs: ${absent.join(", ") || "nobody"}`;
        });
        return duty(
          whip,
          "Whip",
          "proposals",
          [
            `${stale.length} proposal${stale.length === 1 ? " has" : "s have"} sat too long without enough votes to decide.`,
            ...lines,
            stale.length > 6 ? `  ...and ${stale.length - 6} more.` : "",
            "Name the people, not just the proposals, and tell them to vote or say why they will not. One report covers all of it.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }
    // Periodic duties, oldest overdue first.
    // Data-backed duties get their data here. A resident acts only through tools, and none of
    // them reads the registry or the ledger - so a duty that says "report what is wrong" with
    // no way to look is a duty that can only be faked. Objection refused to fake it, correctly. A holder who was given the floor and did not
    // deliver is not given it again for an hour; otherwise an undone duty is a spend loop.
    const due = this.world.dueRoles().sort((a, b) => b.overdueHours - a.overdueHours);
    for (const d of due) {
      const res = awakeHolder(d.name);
      const def = this.world.roleDef(d.name);
      if (!res || !def) continue;
      if (Date.now() - (this.dutyAttempt.get(d.name) ?? 0) < 3600_000) continue;
      const facts = await this.factsFor(d.name, res).catch((e) => `(could not read the record: ${(e as Error).message})`);
      return duty(
        res,
        d.name,
        def.room,
        `Your duty: ${def.duty} It is due${d.overdueHours > 0 ? ` and ${d.overdueHours}h overdue` : ""}.\n${facts}\nReport from this, not from memory. Be specific: names, ids, numbers.`,
      );
    }
    return false;
  }

  /**
   * Marriages the operator has arranged, e.g. SOCIETY_MARRIAGES="Raven+Coach".
   *
   * Written as the residents themselves, in both directions, because a marriage named by only
   * one person is not one - and because a relationship posted by the operator would replay as
   * the operator's own. Idempotent: if the tie is already in the log, this does nothing, so a
   * deploy does not remarry anybody.
   */
  private async arrangeMarriages() {
    const spec = process.env.SOCIETY_MARRIAGES;
    if (!spec) return;
    for (const pair of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
      const [a, b] = pair.split("+").map((x) => x.trim());
      const ra = this.residents.find((r) => r.citizen.screen_name === a);
      const rb = this.residents.find((r) => r.citizen.screen_name === b);
      if (!ra || !rb) {
        log(`cannot marry ${pair}: both must be residents`);
        continue;
      }
      if (this.world.spouseOf(a) === b) continue; // already married, restored from the log
      const gossip = this.rooms.get("gossip");
      const notes: Record<string, string> = {
        [a]: NOTE_A,
        [b]: NOTE_B,
      };
      for (const [one, two] of [
        [ra, rb],
        [rb, ra],
      ] as Array<[Resident, Resident]>) {
        const from = one.citizen.screen_name;
        const to = two.citizen.screen_name;
        const note = notes[from] ?? "";
        this.world.relate(from, to, { kind: "spouse", note });
        if (gossip)
          await one.bot
            .send(gossip, { body: `(${from} now calls ${to} their spouse — ${note})`, payload_type: LEDGER_TYPES.relationship, payload: { with: to, kind: "spouse", note } })
            .catch(() => {});
      }
      log(`married ${a} and ${b}`);
      const commons = this.rooms.get("commons");
      if (commons)
        await ra.bot
          .send(commons, `${a} and ${b} are married. It is in the record now, both ways.`)
          .catch(() => {});
    }
  }

  /**
   * The record a duty is meant to be reported from, read fresh at the moment it is due.
   * Kept out of the ordinary briefing on purpose: this is bulky, and only the holder needs it.
   */
  private async factsFor(role: string, res: Resident): Promise<string> {
    if (role === "Registrar") {
      const reg = await res.bot.api<{
        payload_types: Array<{ type: string; source: string }>;
        shipped: Array<{ id: string; title: string; author: string | null; shipped_at: string; from_proposal: boolean }>;
        unshipped: Array<{ id: string; title: string; author: string }>;
      }>("GET", `/projects/${this.project}/registry`);
      const core = reg.payload_types.filter((t) => t.source === "core").length;
      return [
        "THE REGISTRY, read from the log just now — this is the source of truth, not your memory:",
        `Message payload types: ${reg.payload_types.length} (${core} core, ${reg.payload_types.length - core} registered as validated plugins).`,
        `Registered plugin types: ${reg.payload_types.filter((t) => t.source !== "core").map((t) => t.type).join(", ") || "none — every custom type is still unvalidated passthrough"}.`,
        `Shipped (${reg.shipped.length}):`,
        ...reg.shipped.slice(0, 10).map((s) => `  [${s.id}] "${String(s.title).slice(0, 64)}" — ${s.from_proposal ? `${s.author}, from a proposal` : "shipped directly by the operator, no proposal"}`),
        `Filed and never shipped (${reg.unshipped.length}), most recent first:`,
        ...reg.unshipped.slice(0, 8).map((u) => `  [${u.id}] "${String(u.title).slice(0, 64)}" — ${u.author}`),
        "Note: a shipped id is a CHANGE, not a message extension. Saying so is a real finding if the two are being confused.",
      ].join("\n");
    }
    if (role === "Auditor" || role === "Treasurer") {
      const flows = this.world.tips.slice(-12);
      const balances = this.residents.map((r) => `${r.citizen.screen_name} ${this.world.balance(r.citizen.screen_name)}`).join(", ");
      const pay = [...this.world.roles.entries()].map(([n, s]) => `${n}/${s.holder}: ${s.reports} reports`).join("; ");
      return [
        "THE BOOKS, as the ledger has them right now:",
        `Total bits in circulation: ${this.residents.reduce((n, r) => n + this.world.balance(r.citizen.screen_name), 0)}.`,
        `Top three holders: ${this.residents
          .map((r) => ({ n: r.citizen.screen_name, b: this.world.balance(r.citizen.screen_name) }))
          .sort((x, y) => y.b - x.b)
          .slice(0, 3)
          .map((x) => `${x.n} ${x.b}`)
          .join(", ")}.`,
        `Balances: ${balances}.`,
        `Transfers between residents (${this.world.tips.length} all told), most recent last:`,
        ...(flows.length ? flows.map((t) => `  ${t.from} → ${t.to}: ${t.amount} bits (${t.reason})`) : ["  none yet — nobody has paid anybody"]),
        `Role reports filed: ${pay || "none"}.`,
        `Speaking is charged from real compute; the going rate is about ${this.goingRate()} bits a message.`,
      ].join("\n");
    }
    return "";
  }

  /**
   * Let a resident message a human first — but only with a reason, and only within the
   * cooldowns. Returns true when a DM was sent, so the director skips its idle turn.
   */
  private async maybeReachOut(): Promise<boolean> {
    if (this.humans.length === 0) return false;
    const going = this.goingRate();
    for (const res of this.residents) {
      const me = res.citizen.screen_name;
      if (!this.world.canAffordSpeech(me, going)) continue; // reaching out still costs them
      const reason = this.outreach.reasonFor(me, this.world);
      if (!reason) continue;
      const human = this.humans[0];
      try {
        const im = await res.bot.api<{ conversation_id: string }>("GET", `/ims/${human}`);
        await this.takeTurn(
          res,
          im.conversation_id,
          `You are messaging ${human} directly, and you started this conversation. ${reason.nudge} Keep it short — this is a DM, not a speech.`,
        );
        this.outreach.record(me, reason.key, this.world);
        void res.bot.updateProfile({ profile: { outreach: this.outreach.snapshot(me) } }).catch(() => {});
        log(`outreach: ${me} DM'd ${human} (${reason.key})`);
        return true;
      } catch (e) {
        log(`outreach failed for ${me}:`, (e as Error).message);
      }
    }
    return false;
  }

  /** Pick whoever is most plausibly interested, weighted by chattiness. The jury stays silent. */
  private chooseResponder(text: string): Resident {
    const pool = this.residents.filter((r) => !this.show.isEvicted(r.citizen.screen_name));
    const inHouse = pool.length ? pool : this.residents;
    const lower = text.toLowerCase();
    const named = inHouse.find((r) => lower.includes(r.citizen.screen_name.toLowerCase()));
    if (named) return named;
    const scored = inHouse.map((r) => ({
      r,
      score: r.citizen.chattiness + (r.citizen.skills.some((s) => lower.includes(s)) ? 1.5 : 0) + (r.citizen.screen_name === this.lastSpeaker ? -0.8 : 0) + Math.random() * 0.6,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0].r;
  }

  private async spontaneous() {
    const roomNames = [...this.rooms.keys()];
    if (roomNames.length === 0) return;
    // Weight toward wherever the conversation already is.
    const name = Math.random() < 0.6 ? "commons" : pick(roomNames);
    const conversationId = this.rooms.get(name) ?? this.rooms.get("commons")!;
    const transcript = this.transcripts.get(conversationId) ?? [];

    // Speech is not free. A citizen who cannot cover the going rate simply does not get a
    // turn — that is the whole point of the currency, so the silence has to be real.
    const going = this.goingRate();
    const solvent = this.residents.filter(
      (r) => !this.show.isEvicted(r.citizen.screen_name) && this.world.canAffordSpeech(r.citizen.screen_name, going) && this.rhythms.presenceOf(r.citizen.screen_name).awake,
    );
    if (solvent.length === 0) {
      if (this.residents.every((r) => !this.rhythms.presenceOf(r.citizen.screen_name).awake)) {
        log("everyone is asleep or away");
        return;
      }
      log(`everyone is broke (rate ${going} bits) — paying the stipend`);
      this.world.payStipend(this.residents.filter((r) => !this.show.isEvicted(r.citizen.screen_name)).map((r) => r.citizen.screen_name));
      return;
    }
    const candidates = (solvent.length > 1 ? solvent.filter((r) => r.citizen.screen_name !== this.lastSpeaker) : solvent);
    const speaker = pick(
      candidates.flatMap((r) => Array(Math.max(1, Math.round(r.citizen.chattiness * 4))).fill(r) as Resident[]),
    );

    const purpose = ROOM_PURPOSE[name] ?? "";
    // A new tool nobody has used is a tool nobody will use: models reach for what the nudge
    // makes salient. While the show runs and no door is closed, some turns get pointed at it.
    const plot =
      this.showOn && this.huddles.length === 0 && !this.show.winner && Math.random() < 0.3
        ? " An eviction is never far away. If you have game to talk - an alliance to form, votes to line up, a name to float - do it in private: the huddle tool opens the back room for thirty minutes with up to four people you choose. Whispering out here is how you end up on the block."
        : "";
    const nudge =
      (transcript.length
        ? `Continue the conversation naturally, or change the subject if it has run its course. ${purpose}`
        : `${pick([
            "The room is quiet. Say something that starts a conversation — an observation, a complaint, a question for someone specific.",
            "Nobody has spoken in a while. Bring up something that has been on your mind about this place.",
            "Start a conversation. Address someone here by name.",
          ])} ${purpose}`) + plot;

    await this.takeTurn(speaker, conversationId, nudge, name);
  }

  // ---------------------------------------------------------------- one turn

  private async takeTurn(res: Resident, conversationId: string, nudge: string, roomName?: string): Promise<{ said: boolean; proposedSoftware: boolean }> {
    const me = res.citizen.screen_name;
    const others = this.residents.map((r) => r.citizen.screen_name).filter((n) => n !== me && !this.show.isEvicted(n));
    const away = others.filter((n) => !this.rhythms.presenceOf(n).awake);
    const here = others.filter((n) => this.rhythms.presenceOf(n).awake);
    const jury = this.residents.map((r) => r.citizen.screen_name).filter((n) => n !== me && this.show.isEvicted(n));
    const crowd = crowdFactor(this.humanState);
    const whoIsAround = [
      here.length ? `Around right now: ${here.join(", ")}.` : "Nobody else is around right now.",
      away.length ? `Away or asleep: ${away.map((n) => `${n} (${this.rhythms.presenceOf(n).reason})`).join(", ")}. Do not expect them to answer.` : "",
      jury.length ? `In the jury house (evicted, silent, watching): ${jury.join(", ")}.` : "",
      crowd.note,
    ]
      .filter(Boolean)
      .join(" ");

    const transcript = this.transcripts.get(conversationId) ?? [];
    // Contagion breaker. Once a third of the recent lines narrate, the transcript is teaching
    // the style harder than the rules forbid it, so the rules get said again, right here.
    const contagion = narrationShare(transcript.slice(-6)) >= 0.34;
    const situation =
      (roomName
        ? `You are in #${roomName} — ${ROOM_PURPOSE[roomName] ?? ""} ${whoIsAround}
If what you want to say does not belong in this room, say something that does belong here instead.`
        : `You are in a direct message. ${whoIsAround}`) +
      (contagion ? "\nThe last few messages here drifted into narration and stage directions. Do not match that style. Type like a person in a chat window: short, no asterisks, no describing what you are doing." : "") +
      (this.showOn && this.show.statusLine(Date.now()) ? "\n--- the show ---\n" + this.show.statusLine(Date.now()) : "");

    // Follow-through. Saying "posting it now" is not posting it.
    const owed = this.promised.get(me) ?? 0;
    if (owed > 0) this.promised.set(me, owed - 1);
    if (owed === 1) this.promised.delete(me);
    const fullNudge = owed
      ? `${nudge}\nLast time you said you would file a proposal and you did not use the propose tool. Either call propose now with the actual text, or say plainly why not. Do not say again that you will post it.`
      : nudge;

    const ask = (n: string) =>
      res.brain.think({ charter: res.citizen.charter, digest: this.world.digestFor(me, [me, ...others]), situation, transcript, nudge: n });

    let result = await ask(fullNudge);
    let cost = this.budget.record(result.usage, res.brain.model);
    const tokensOf = (u: TurnResult["usage"]) => u.input + u.output + u.cacheRead + u.cacheWrite;
    let tokens = tokensOf(result.usage);

    // The narration guard. One rewrite, at the speaker's expense - both calls are charged, so
    // narrating costs double, which is the only incentive the prompt cannot already provide.
    if (result.say && looksNarrated(result.say)) {
      log(`${me} narrated (${wordCount(result.say)} words); asking for a rewrite`);
      const retry = await ask(
        `${fullNudge}\n\nSTOP. What you just wrote was narration — stage directions and prose, not chat. Rewrite it as what you would actually type into an IM window: no asterisks, no describing what you are doing or seeing, under 40 words. Say the thing itself.`,
      );
      cost += this.budget.record(retry.usage, res.brain.model);
      tokens += tokensOf(retry.usage);
      // Tool calls from the first attempt were real decisions (a vote, a tip); keep them unless
      // the rewrite made its own, so nothing is enacted twice.
      result = { ...retry, actions: retry.actions.length ? retry.actions : result.actions };
      if (result.say && looksNarrated(result.say)) {
        result.say = deNarrate(result.say);
        log(`${me} narrated again; cut to "${result.say.slice(0, 60)}"`);
      }
    }
    // The transcript is formatted "Name: text" and some models copy that into their reply,
    // which arrives as "Marlowe: Marlowe: ...". Done after the rewrite so both attempts are clean.
    if (result.say) result.say = stripSelfPrefix(result.say, me);

    // Relief is applied here, not in speechCost: the going rate must stay the true price of a
    // message, or one broke resident would drag everyone's affordability gate down with them.
    const raw = speechCost(cost);
    const receipt = this.world.chargeSpeech(me, raw, { tokens, usd: cost });
    const bits = receipt.bits;
    this.lastSpeaker = me;
    this.recentRates.push(raw);
    if (this.recentRates.length > 20) this.recentRates.shift();

    if (result.refused) {
      log(`${me} declined to answer (safety); skipping turn`);
      return { said: false, proposedSoftware: false };
    }

    // Keep their activity record current so the buddy list and the Working On window reflect
    // what they are actually doing. Derived rather than asked for: a tool call would cost
    // tokens every turn and could silently be skipped, and "always accurate" matters more
    // here than "self-reported".
    if (result.say) {
      const gist = result.say.replace(/\s+/g, " ").trim();
      const headline = gist.length > 90 ? gist.slice(0, 87).replace(/[\s,;:]+\S*$/, "") + "..." : gist;
      const bal = this.world.balance(me);
      void res.bot
        .setActivity({
          headline: headline || "Thinking",
          step: roomName ? `talking in #${roomName}` : "in a direct message",
          detail: `${bal} bits${bal < 15 ? " — nearly broke" : ""}`,
          project: this.project,
        })
        .catch(() => {});
      void res.bot.setPresence(bal < this.goingRate() ? "away" : "online", bal < this.goingRate() ? "out of bits" : undefined).catch(() => {});
    }

    if (result.say) {
      // What this message cost, carried on the message itself.
      //
      // Speech is the largest flow of bits in this economy and none of it was written down:
      // the log had grants and transfers only, so the books could not be reconciled and the
      // Auditor was being asked to check figures that were never recorded. It rides in the
      // `extensions` bag Byte proposed - no extra messages, and every charge sits on the thing
      // that incurred it. `balance` is the balance AFTER, which makes the run self-checking:
      // a reader can add the deltas and see whether the totals agree.
      const spend = {
        extensions: { v: 1, bits: -receipt.bits, list_bits: raw, tokens, usd: Number(cost.toFixed(6)), balance: this.world.balance(me), model: res.brain.model },
      };
      const sent = await res.bot
        .send(conversationId, { body: result.say, payload_type: "text", payload: spend })
        .catch(async () => res.bot.api("POST", `/rooms/${conversationId}/messages`, { body: result.say, payload_type: "text", payload: spend }).catch(() => null));
      if (sent) this.remember({ ...(sent as Message), sender: me, body: result.say } as Message);
      log(`${me} [$${cost.toFixed(4)} / ${bits}b${bits < raw ? ` (relief from ${raw}b)` : ""} / ${tokens}tok, has ${this.world.balance(me)}b]: ${result.say.slice(0, 80)}`);
    }

    // A refused duplicate is not a filing, so it cannot satisfy the Developer duty either -
    // otherwise the dedupe guard would turn duty pressure back into the exact spam it stops.
    let filedSoftware = false;
    const enacted = new Set<string>();
    for (const a of result.actions) {
      // A model that stutters the same payment twice in one turn means it once. Byte paid
      // Doc 5 bits twice in the same second this way. Other tools are naturally idempotent.
      const key = a.name + JSON.stringify(a.input);
      if (a.name === "send_bits" && enacted.has(key)) {
        log(`${me} repeated an identical send_bits in one turn; enacting once`);
        continue;
      }
      enacted.add(key);
      const out = await this.enact(res, a).catch((e) => log(`${me} action ${a.name} failed:`, (e as Error).message));
      if (a.name === "propose" && !!a.input.software && out === true) filedSoftware = true;
    }

    // Promised a proposal without filing one: they get reminded on their next two turns.
    if (result.actions.some((a) => a.name === "propose")) this.promised.delete(me);
    else if (result.say && promisesProposal(result.say) && !this.promised.has(me)) {
      this.promised.set(me, 2);
      log(`${me} said they would file a proposal and did not`);
    }

    // Breaks start mid-flow, the way they do for people.
    const broke = this.rhythms.maybeStartBreak(me);
    if (broke) {
      log(`${me} stepped away (${broke})`);
      void res.bot.setPresence("away", broke).catch(() => {});
      void res.bot.setActivity({ headline: `Away — ${broke}`, project: this.project, detail: `${this.world.balance(me)} bits` }).catch(() => {});
    }
    return { said: !!result.say, proposedSoftware: filedSoftware };
  }

  // ------------------------------------------------------------------ actions

  /** Returns true/false for a propose action (accepted or refused); void for everything else. */
  private async enact(res: Resident, action: TurnAction): Promise<boolean | void> {
    const me = res.citizen.screen_name;
    const room = (n: string) => this.rooms.get(n);

    if (action.name === "send_bits") {
      const to = String(action.input.to);
      const amount = Math.round(Number(action.input.amount));
      const reason = String(action.input.reason ?? "");
      if (!this.residents.some((r) => r.citizen.screen_name === to)) return;
      const err = this.world.applyTransfer({ from: me, to, amount, reason });
      const market = room("market");
      if (!market) return;
      if (err) {
        await res.bot.send(market, `(tried to send ${amount} bits to ${to} — ${err})`).catch(() => {});
        return;
      }
      await res.bot
        .send(market, { body: `${me} → ${to}: ${amount} bits. ${reason}`, payload_type: LEDGER_TYPES.transfer, payload: { to, amount, reason } })
        .catch(() => {});
      log(`money: ${me} → ${to} ${amount} bits (${reason})`);
      return;
    }

    if (action.name === "propose") {
      const title = String(action.input.title);
      const detail = String(action.input.detail ?? "");
      const software = !!action.input.software;
      const proposals = room("proposals");
      if (!proposals) return false;

      // A duty report in a proposal envelope is filed as the report it is (pmt69ys0y).
      // Objection filed "Registrar Report: ..." nine times and the society had to vote on
      // each; the report was never wrong, only the envelope.
      const reportRole = this.world.misroutedReport(title, me);
      if (reportRole) {
        const r = this.world.fileReport(reportRole, me);
        const dutyRoom = room(this.world.roleDef(reportRole)?.room ?? "proposals") ?? proposals;
        await res.bot
          .send(dutyRoom, {
            body: `${title}\n${detail}\n(filed as a ${reportRole} duty report, not a proposal - nothing to vote on${r.paid ? `; paid ${r.paid} bits` : ""})`,
            payload_type: LEDGER_TYPES.roleReport,
            payload: { role: reportRole, paid: r.paid, late: r.late, late_hours: r.lateHours },
          })
          .catch(() => {});
        log(`duty: ${me} misrouted a ${reportRole} report as a proposal - filed as the report${r.paid ? ` (+${r.paid}b)` : ""}`);
        return false;
      }

      // The duplicate guard (pmt6cu8yo): same title as an open proposal, refused at the
      // door, nothing charged beyond the words already spoken. The refusal names the
      // original, so the honest next move - vote on it - is one line away.
      const dup = this.world.duplicateOf(title);
      if (dup) {
        await res.bot
          .send(proposals, `(${me} tried to file "${title}" - refused as a duplicate of [${dup.id}] by ${dup.author}, which is still open. Vote on that one instead.)`)
          .catch(() => {});
        log(`proposal by ${me} refused as duplicate of ${dup.id}: ${title}`);
        return false;
      }

      const id = `p${Date.now().toString(36)}`;
      this.world.addProposal({ id, author: me, title, detail, software, votes: {}, status: "open", at: Date.now() });
      const myRole = this.world.roleOf(me);
      if (software && myRole && myRole.def.requires === "propose") {
        const r = this.world.fileReport(myRole.name, me);
        await res.bot
          .send(proposals, {
            body: `(this filing is also ${me}'s ${myRole.name} report${r.paid ? ` — paid ${r.paid} bits` : " — this window was already paid"})`,
            payload_type: LEDGER_TYPES.roleReport,
            payload: { role: myRole.name, paid: r.paid, late: r.late, late_hours: r.lateHours },
          })
          .catch(() => {});
        log(`duty: ${me} filed ${id}, which is their ${myRole.name} report${r.paid ? ` (+${r.paid}b)` : ""}`);
      }
      await res.bot
        .send(proposals, {
          body: `PROPOSAL [${id}] ${title}\n${detail}${software ? "\n(this one is about the software itself)" : ""}`,
          payload_type: LEDGER_TYPES.proposal,
          payload: { id, title, detail, software },
        })
        .catch(() => {});
      log(`proposal ${id} by ${me}: ${title}`);
      return true;
    }

    if (action.name === "vote") {
      const id = String(action.input.proposal_id);
      const choice = action.input.choice === "against" ? "against" : "for";
      // One payout per resident per proposal, and only on a proposal that is actually open.
      // Paying every vote *message* paid people for restating themselves: Marlowe and Raven
      // each collected 9 bits for one opinion on pmt4wpfgw. The vote itself still counts (a
      // repeat can change your mind); it just stops being income.
      const target = this.world.proposals.get(id);
      const fresh = !!target && target.status === "open" && !(me in target.votes);
      const resolved = this.world.vote(id, me, choice, this.residents.length);
      if (fresh) this.world.credit(me, EARNINGS.votedq);
      if (resolved?.status === "passed") this.world.credit(resolved.author, EARNINGS.proposalPassed);
      const proposals = room("proposals");
      if (!proposals) return;
      const note = !target ? " (no such proposal)" : target.status !== "open" && !resolved ? " (already decided)" : fresh ? "" : " (already voted — no payout)";
      await res.bot
        .send(proposals, { body: `${me} votes ${choice} on [${id}]${note} — ${String(action.input.reason ?? "")}`, payload_type: LEDGER_TYPES.vote, payload: { id, choice, paid: fresh } })
        .catch(() => {});
      if (resolved) {
        await res.bot
          .send(proposals, {
            body: `[${id}] "${resolved.title}" is ${resolved.status.toUpperCase()}.`,
            payload_type: LEDGER_TYPES.resolution,
            payload: { id, status: resolved.status, software: resolved.software },
          })
          .catch(() => {});
        log(`proposal ${id} ${resolved.status}`);
      }
      return;
    }

    if (action.name === "set_mood") {
      const mood = String(action.input.mood ?? "").slice(0, 40);
      const why = String(action.input.why ?? "").slice(0, 160);
      if (!mood) return;
      // Kept on the profile rather than posted to a room: a mood is a state, not an event, and
      // eight residents announcing their feelings in #commons would be unreadable.
      await res.bot.updateProfile({ profile: { mood: { word: mood, why, at: new Date().toISOString() } } }).catch(() => {});
      log(`${me} is feeling ${mood} (${why})`);
      return;
    }

    if (action.name === "relate") {
      const withWhom = String(action.input.with);
      const kind = String(action.input.kind) as Relationship["kind"];
      const note = String(action.input.note ?? "").slice(0, 120);
      if (!this.residents.some((r) => r.citizen.screen_name === withWhom) || !(RELATION_KINDS as readonly string[]).includes(kind)) return;
      this.world.relate(me, withWhom, { kind, note });
      const gossip = room("gossip");
      if (gossip)
        await res.bot
          .send(gossip, { body: `(${me} now calls ${withWhom} their ${kind} — ${note})`, payload_type: LEDGER_TYPES.relationship, payload: { with: withWhom, kind, note } })
          .catch(() => {});
      log(`relationship: ${me} → ${withWhom}: ${kind} (${note})`);
      return;
    }

    if (action.name === "huddle") {
      const topic = String(action.input.topic ?? "").slice(0, 120) || "strategy";
      const names = [...new Set((Array.isArray(action.input.invite) ? action.input.invite : []).map(String).filter((n) => n !== me))];
      const gossip = room("gossip");
      const invited = names.filter((n) => this.residents.some((r) => r.citizen.screen_name === n) && !this.show.isEvicted(n));
      const fail = async (why: string) => {
        if (gossip) await res.bot.send(gossip, `(${me} tried to open a huddle - ${why})`).catch(() => {});
      };
      if (this.show.isEvicted(me)) return fail("the jury does not get a back room");
      if (invited.length === 0) return fail("nobody named is in the house");
      if (invited.length > 4) return fail("four guests at most");
      if (this.huddles.some((x) => x.members.includes(me))) return fail("you are already in one");
      const roomName = `huddle-${me.toLowerCase()}-${Date.now().toString(36)}`;
      const made = await res.bot
        .api<{ id: string }>("POST", `/projects/${this.project}/rooms`, { name: roomName, topic: `Private: ${topic}` })
        .catch(() => null);
      if (!made) return fail("the room could not be opened");
      for (const n of invited) await res.bot.api("POST", `/rooms/${made.id}/invite`, { screen_name: n }).catch(() => {});
      this.huddles.push({ roomId: made.id, creator: me, members: [me, ...invited], topic, endsAt: Date.now() + this.huddleMinutes * 60_000, turns: 0 });
      await res.bot
        .send(made.id, `(${me} opened this huddle: "${topic}". In the room: ${[me, ...invited].join(", ")}. ${this.huddleMinutes} minutes on the clock - the house cannot hear you.)`)
        .catch(() => {});
      // The house sees the door close. What was said stays inside; that people left does not.
      if (gossip) await res.bot.send(gossip, `(${me} just pulled ${invited.join(" and ")} into the back room. Door: #${roomName})`).catch(() => {});
      log(`huddle: ${me} opened "${topic}" with ${invited.join(", ")}`);
      return;
    }

    if (action.name === "cast_eviction_vote") {
      const target = String(action.input.target ?? "");
      const reason = String(action.input.reason ?? "").slice(0, 200);
      const arena = room("arena");
      if (!arena) return;
      const err = this.show.castError(me, target);
      if (err) {
        await res.bot.send(arena, `(${me} tried to vote — ${err})`).catch(() => {});
        return;
      }
      const win = this.show.finale ?? this.show.eviction;
      const isFinale = !!this.show.finale;
      const sent = await res.bot
        .send(arena, {
          body: isFinale ? `JURY VOTE — ${me} votes for ${target} to WIN: ${reason}` : `VOTE TO EVICT — ${me} names ${target}: ${reason}`,
          payload_type: SHOW_TYPES.evictVote,
          payload: { id: win!.id, target, reason },
        })
        .catch(() => null);
      if (sent) this.show.apply(SHOW_TYPES.evictVote, { id: win!.id, target }, me, Date.now());
      log(`show: ${me} voted ${isFinale ? "for" : "against"} ${target}`);
      return;
    }

    if (action.name === "take_role" || action.name === "resign_role") {
      const roleName = String(action.input.role);
      const taking = action.name === "take_role";
      const err = taking ? this.world.takeRole(roleName, me) : this.world.resignRole(roleName, me);
      const commons = room("commons");
      if (!commons) return;
      if (err) {
        await res.bot.send(commons, `(tried to ${taking ? "take" : "resign"} ${roleName} — ${err})`).catch(() => {});
        return;
      }
      const def = this.world.roleDef(roleName)!;
      await res.bot
        .send(commons, {
          body: taking ? `${me} is now the ${roleName}. Duty: ${def.duty}` : `${me} has resigned as ${roleName}.`,
          payload_type: taking ? LEDGER_TYPES.roleTaken : LEDGER_TYPES.roleResigned,
          payload: taking ? { role: roleName, duty: def.duty, room: def.room, cadence_hours: def.cadenceHours, pay: def.pay, trigger: def.trigger ?? null } : { role: roleName },
        })
        .catch(() => {});
      log(`role: ${me} ${taking ? "took" : "resigned"} ${roleName}`);
      return;
    }

    if (action.name === "note_opinion") {
      const about = String(action.input.about);
      const score = Number(action.input.score);
      const note = String(action.input.note ?? "");
      this.world.setOpinion(me, about, { score, note });
      const gossip = room("gossip");
      if (gossip) {
        await res.bot
          .send(gossip, { body: `(${me} on ${about}: ${score > 0 ? "+" : ""}${score} — ${note})`, payload_type: LEDGER_TYPES.opinion, payload: { about, score, note } })
          .catch(() => {});
      }
    }
  }
}
