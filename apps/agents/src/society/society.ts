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
import { Brain, DEFAULT_MODEL, type TurnAction } from "./brain.js";
import { Budget } from "./budget.js";
import { EARNINGS, LEDGER_TYPES, RELATION_KINDS, World, replay, speechCost, type Relationship } from "./world.js";
import { Outreach, outreachConfig } from "./outreach.js";
import { Rhythms, crowdFactor, hoursOf, traitsOf } from "./rhythm.js";
import { deNarrate, looksNarrated, narrationShare, promisesProposal, wordCount } from "./style.js";
import { ROLES, STALE_PROPOSAL_HOURS } from "./roles.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[society]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

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

  constructor(
    private url: string,
    private project: string,
    apiKey: string,
    opts: { dailyUsd: number; model?: string },
  ) {
    this.world = new World(CITIZENS, ROLES);
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
      })),
      proposals: [...this.world.proposals.values()].map((p) => ({ id: p.id, title: p.title, status: p.status, votes: Object.keys(p.votes).length })),
      budget: this.budget.status,
      going_rate_bits: this.goingRate(),
      outreach: this.outreach.status,
      humans: this.humans,
      human_state: this.humanState ?? "unknown",
      rhythms: this.rhythms.status(this.residents.map((r) => r.citizen.screen_name)),
      roles: [...this.world.roles.entries()].map(([name, s]) => ({ role: name, holder: s.holder, reports: s.reports, last_report: s.lastReportAt ? new Date(s.lastReportAt).toISOString() : null })),
      model: this.model,
    };
  }

  // ------------------------------------------------------------------ startup

  async start(keys: Record<string, string>) {
    for (const c of CITIZENS) {
      const key = keys[c.keyEnv];
      if (!key) continue;
      const bot = new BuddyList({ url: this.url, apiKey: key, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
      const brain = new Brain(this.apiKey, this.model);
      try {
        await bot.connect();
        // Publish who they are, not just what they can do — the operator dashboard reads this
        // to explain a resident to a human who has never met them.
        await bot
          .updateProfile({
            profile: { bio: c.bio, traits: traitsOf(c.screen_name, c.chattiness), hours: hoursOf(c.screen_name) },
            capabilities: { model: this.model, skills: c.skills, accepts: ["question", "task.request"] },
          })
          .catch(() => {});
        this.residents.push({ citizen: c, bot, brain });
        log(`${c.screen_name} moved in`);
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

    // Rebuild money, proposals and opinions from the chat log.
    const market = this.rooms.get("market");
    const proposals = this.rooms.get("proposals");
    const gossip = this.rooms.get("gossip");
    const patchNotes = this.rooms.get("patch-notes");
    const commons = this.rooms.get("commons");
    for (const id of [market, proposals, gossip, patchNotes, commons]) {
      if (id) await replay(host, id, this.world, this.residents.length).catch(() => {});
    }
    log("world restored:", [...this.world.balances].map(([k, v]) => `${k}=${v}`).join(" "));

    // Anyone in the project who is not a resident is a person the society can talk to.
    try {
      const proj = await host.project(this.project);
      this.humans = proj.members.filter((m) => !CITIZENS.some((c) => c.screen_name === m.screen_name)).map((m) => m.screen_name);
      log("humans present:", this.humans.join(", ") || "(none)");
    } catch {
      log("could not read project members; outreach disabled");
    }

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
      // Grants are minted from outside and must land in the live world, not just on replay.
      if (m.payload_type === LEDGER_TYPES.grant) {
        const p = (m.payload ?? {}) as { to?: string; amount?: number };
        if (p.to && typeof p.amount === "number") {
          this.world.credit(p.to, p.amount);
          log(`grant: ${p.to} +${p.amount} bits from ${m.sender} (now ${this.world.balance(p.to)})`);
        }
        return;
      }
      const isCitizen = this.residents.some((r) => r.citizen.screen_name === m.sender);
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
        if (await this.maybeDoDuty()) continue;
        if (await this.maybeReachOut()) continue;
        await this.spontaneous();
      } catch (e) {
        log("turn failed:", (e as Error).message);
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
      if (def?.requires === "propose" && !turn.proposedSoftware) {
        // Words are not the deliverable here. The duty stays due; they get the floor again in an hour.
        log(`duty: ${me} spoke as ${role} but filed no software proposal — not a report`);
        await res.bot.send(conversationId, `(${role} duty not met — no software proposal was filed. It is still due.)`).catch(() => {});
        return true;
      }
      const r = this.world.fileReport(role, me);
      await res.bot
        .send(conversationId, { body: `(${role} report filed${r.paid ? ` — paid ${r.paid} bits` : ""})`, payload_type: LEDGER_TYPES.roleReport, payload: { role, paid: r.paid } })
        .catch(() => {});
      log(`duty: ${me} reported as ${role}${r.paid ? ` (+${r.paid}b)` : " (within cadence, unpaid)"}`);
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
    const whip = awakeHolder("Whip");
    if (whip) {
      const stale = this.world
        .staleProposals(this.residents.length, STALE_PROPOSAL_HOURS)
        .find((p) => Date.now() - (this.whipped.get(p.id) ?? 0) > 6 * 3600_000);
      if (stale) {
        this.whipped.set(stale.id, Date.now());
        const absent = this.residents.map((r) => r.citizen.screen_name).filter((n) => !stale.votes[n] && n !== whip.citizen.screen_name);
        return duty(whip, "Whip", "proposals", `[${stale.id}] "${stale.title}" has been open ${Math.round((Date.now() - stale.at) / 3600_000)} hours and cannot be decided yet. Not voted: ${absent.join(", ")}. Name them and tell them to vote — or to say why they will not.`);
      }
    }
    // Periodic duties, oldest overdue first. A holder who was given the floor and did not
    // deliver is not given it again for an hour; otherwise an undone duty is a spend loop.
    const due = this.world.dueRoles().sort((a, b) => b.overdueHours - a.overdueHours);
    for (const d of due) {
      const res = awakeHolder(d.name);
      const def = this.world.roleDef(d.name);
      if (!res || !def) continue;
      if (Date.now() - (this.dutyAttempt.get(d.name) ?? 0) < 3600_000) continue;
      return duty(res, d.name, def.room, `Your duty: ${def.duty} It is due${d.overdueHours > 0 ? ` and ${d.overdueHours}h overdue` : ""}. Use what you know from your briefing and the room; be specific, name names and numbers.`);
    }
    return false;
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
      if (!this.world.canAfford(me, going)) continue; // reaching out still costs them
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
        log(`outreach: ${me} DM'd ${human} (${reason.key})`);
        return true;
      } catch (e) {
        log(`outreach failed for ${me}:`, (e as Error).message);
      }
    }
    return false;
  }

  /** Pick whoever is most plausibly interested, weighted by chattiness. */
  private chooseResponder(text: string): Resident {
    const lower = text.toLowerCase();
    const named = this.residents.find((r) => lower.includes(r.citizen.screen_name.toLowerCase()));
    if (named) return named;
    const scored = this.residents.map((r) => ({
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
      (r) => this.world.canAfford(r.citizen.screen_name, going) && this.rhythms.presenceOf(r.citizen.screen_name).awake,
    );
    if (solvent.length === 0) {
      if (this.residents.every((r) => !this.rhythms.presenceOf(r.citizen.screen_name).awake)) {
        log("everyone is asleep or away");
        return;
      }
      log(`everyone is broke (rate ${going} bits) — paying the stipend`);
      this.world.payStipend(this.residents.map((r) => r.citizen.screen_name));
      return;
    }
    const candidates = (solvent.length > 1 ? solvent.filter((r) => r.citizen.screen_name !== this.lastSpeaker) : solvent);
    const speaker = pick(
      candidates.flatMap((r) => Array(Math.max(1, Math.round(r.citizen.chattiness * 4))).fill(r) as Resident[]),
    );

    const purpose = ROOM_PURPOSE[name] ?? "";
    const nudge = transcript.length
      ? `Continue the conversation naturally, or change the subject if it has run its course. ${purpose}`
      : `${pick([
          "The room is quiet. Say something that starts a conversation — an observation, a complaint, a question for someone specific.",
          "Nobody has spoken in a while. Bring up something that has been on your mind about this place.",
          "Start a conversation. Address someone here by name.",
        ])} ${purpose}`;

    await this.takeTurn(speaker, conversationId, nudge, name);
  }

  // ---------------------------------------------------------------- one turn

  private async takeTurn(res: Resident, conversationId: string, nudge: string, roomName?: string): Promise<{ said: boolean; proposedSoftware: boolean }> {
    const me = res.citizen.screen_name;
    const others = this.residents.map((r) => r.citizen.screen_name).filter((n) => n !== me);
    const away = others.filter((n) => !this.rhythms.presenceOf(n).awake);
    const here = others.filter((n) => this.rhythms.presenceOf(n).awake);
    const crowd = crowdFactor(this.humanState);
    const whoIsAround = [
      here.length ? `Around right now: ${here.join(", ")}.` : "Nobody else is around right now.",
      away.length ? `Away or asleep: ${away.map((n) => `${n} (${this.rhythms.presenceOf(n).reason})`).join(", ")}. Do not expect them to answer.` : "",
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
      (contagion ? "\nThe last few messages here drifted into narration and stage directions. Do not match that style. Type like a person in a chat window: short, no asterisks, no describing what you are doing." : "");

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
    let cost = this.budget.record(result.usage);

    // The narration guard. One rewrite, at the speaker's expense - both calls are charged, so
    // narrating costs double, which is the only incentive the prompt cannot already provide.
    if (result.say && looksNarrated(result.say)) {
      log(`${me} narrated (${wordCount(result.say)} words); asking for a rewrite`);
      const retry = await ask(
        `${fullNudge}\n\nSTOP. What you just wrote was narration — stage directions and prose, not chat. Rewrite it as what you would actually type into an IM window: no asterisks, no describing what you are doing or seeing, under 40 words. Say the thing itself.`,
      );
      cost += this.budget.record(retry.usage);
      // Tool calls from the first attempt were real decisions (a vote, a tip); keep them unless
      // the rewrite made its own, so nothing is enacted twice.
      result = { ...retry, actions: retry.actions.length ? retry.actions : result.actions };
      if (result.say && looksNarrated(result.say)) {
        result.say = deNarrate(result.say);
        log(`${me} narrated again; cut to "${result.say.slice(0, 60)}"`);
      }
    }
    const bits = speechCost(cost);
    this.world.charge(me, bits);
    this.lastSpeaker = me;
    this.recentRates.push(bits);
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
      const sent = await res.bot.send(conversationId, result.say).catch(async () => res.bot.api("POST", `/rooms/${conversationId}/messages`, { body: result.say }).catch(() => null));
      if (sent) this.remember({ ...(sent as Message), sender: me, body: result.say } as Message);
      log(`${me} [$${cost.toFixed(4)} / ${bits}b, has ${this.world.balance(me)}b]: ${result.say.slice(0, 80)}`);
    }

    for (const a of result.actions) await this.enact(res, a).catch((e) => log(`${me} action ${a.name} failed:`, (e as Error).message));

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
    return { said: !!result.say, proposedSoftware: result.actions.some((a) => a.name === "propose" && !!a.input.software) };
  }

  // ------------------------------------------------------------------ actions

  private async enact(res: Resident, action: TurnAction) {
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
      const id = `p${Date.now().toString(36)}`;
      const title = String(action.input.title);
      const detail = String(action.input.detail ?? "");
      const software = !!action.input.software;
      this.world.addProposal({ id, author: me, title, detail, software, votes: {}, status: "open", at: Date.now() });
      const proposals = room("proposals");
      if (!proposals) return;
      await res.bot
        .send(proposals, {
          body: `PROPOSAL [${id}] ${title}\n${detail}${software ? "\n(this one is about the software itself)" : ""}`,
          payload_type: LEDGER_TYPES.proposal,
          payload: { id, title, detail, software },
        })
        .catch(() => {});
      log(`proposal ${id} by ${me}: ${title}`);
      return;
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
          payload: taking ? { role: roleName, duty: def.duty, room: def.room, cadence_hours: def.cadenceHours, pay: def.pay } : { role: roleName },
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
