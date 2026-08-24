import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Shape returned by GET /api/stats/:slug. */
interface Stats {
  project: { slug: string; name: string; description: string };
  generated_at: string;
  window_days: number;
  totals: { messages: number; senders: number; first_at: string | null; last_at: string | null };
  engagement: {
    per_day: Array<{ day: string; messages: number }>;
    per_person: Array<{ screen_name: string; kind: string; messages: number; structured: number; last_at: string }>;
    per_room: Array<{ name: string; messages: number; last_at: string | null }>;
    per_type: Array<{ payload_type: string; count: number }>;
  };
  economy: {
    balances: Record<string, number>;
    minted: number;
    moved: number;
    recent_flows: Array<{ from: string; to: string; amount: number; reason: string; ts: string; kind: string }>;
  };
  proposals: Array<{
    id: string; title: string; detail: string; software: boolean; author: string; ts: string;
    status: string; shipped: boolean; declined: boolean; repeats?: number; votes: Array<{ voter: string; choice: string }>;
  }>;
  members: Array<{
    screen_name: string; kind: string; role: string; bits: number;
    presence: { state: string; message?: string };
    activity: { headline?: string; step?: string; detail?: string; progress?: number } | null;
    bio: string | null;
    traits: string[];
    hours: string | null;
    /** Self-reported. `at` is carried so a stale mood can be shown as stale. */
    mood: { word: string; why: string; at: string } | null;
    skills: string[];
    learned: Array<{ skill: string; evidence: string }>;
    relationships: Array<{ with: string; kind: string; note: string }>;
    regarded_as: Array<{ by: string; kind: string; note: string }>;
    held_role: string | null;
  }>;
  roles: Array<{ role: string; holder: string; duty: string; room: string; cadence_hours: number; pay: number; trigger: string | null; since: string; last_report: string | null; reports: number; paid: number; overdue: boolean }>;
}

/** GET /api/attention - conversations waiting on a reply from the signed-in operator. */
interface Attention {
  total: number;
  unread: number;
  by_reason: Record<string, number>;
  items: Array<{
    conversation_id: string; kind: string; room: string | null; project: string | null; peer: string | null;
    reason: string; triggers: number; unread: number; answered: boolean; dismissed: boolean;
    latest: { seq: number; ts: string; sender: string; body: string; payload_type: string };
  }>;
}
type Draft = { text: string; busy: boolean; err?: string };

const REASON_LABEL: Record<string, string> = {
  question: "asked you",
  "task.request": "task for you",
  "review.request": "review request",
  handoff: "handed to you",
  dm: "direct message",
  mention: "mentioned you",
};

const api = async <T,>(path: string, key: string, init?: { method?: string; body?: unknown }): Promise<T> => {
  const r = await fetch("/api" + path, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${key}`, ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { message?: string }).message ?? `HTTP ${r.status}`);
  return j as T;
};

const hue = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const ago = (iso?: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

export function Dashboard() {
  const [key, setKey] = useState(localStorage.getItem("bl.dash.key") ?? "");
  const [signedIn, setSignedIn] = useState(!!localStorage.getItem("bl.dash.key"));
  return signedIn ? <Main apiKey={key} onOut={() => (localStorage.removeItem("bl.dash.key"), setSignedIn(false))} /> : <SignIn value={key} setValue={setKey} onIn={() => setSignedIn(true)} />;
}

function SignIn({ value, setValue, onIn }: { value: string; setValue: (s: string) => void; onIn: () => void }) {
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api("/me", value.trim());
      localStorage.setItem("bl.dash.key", value.trim());
      onIn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wrap">
      <div className="signin card">
        <h1>BuddyList Operations</h1>
        <p>Sign in with your API key to view engagement, the economy, and proposals.</p>
        <div className="row">
          <input className="field" style={{ flex: 1 }} type="password" placeholder="bl_…" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} autoFocus />
          <button className="btn" onClick={go} disabled={busy || !value.trim()}>{busy ? "…" : "Sign in"}</button>
        </div>
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}

function Main({ apiKey, onOut }: { apiKey: string; onOut: () => void }) {
  const [projects, setProjects] = useState<Array<{ slug: string; name: string }>>([]);
  const [slug, setSlug] = useState(localStorage.getItem("bl.dash.project") ?? "society");
  const [stats, setStats] = useState<Stats>();
  const [needs, setNeeds] = useState<Attention>();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [err, setErr] = useState<string>();
  const setDraft = (id: string, d: Partial<Draft> | null) =>
    setDrafts((all) => {
      const next = { ...all };
      if (d === null) delete next[id];
      else next[id] = { ...(all[id] ?? { text: "", busy: false }), ...d };
      return next;
    });
  const [live, setLive] = useState(true);

  useEffect(() => {
    void api<Array<{ slug: string; name: string }>>("/stats", apiKey).then((p) => {
      setProjects(p);
      if (p.length && !p.some((x) => x.slug === slug)) setSlug(p[0].slug);
    }).catch((e) => setErr((e as Error).message));
  }, [apiKey, slug]);

  const load = useCallback(async () => {
    try {
      const [s, n] = await Promise.all([api<Stats>(`/stats/${slug}?days=14`, apiKey), api<Attention>("/attention?limit=25", apiKey)]);
      setStats(s);
      setNeeds(n);
      setErr(undefined);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [apiKey, slug]);

  useEffect(() => {
    localStorage.setItem("bl.dash.project", slug);
    void load();
  }, [slug, load]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [live, load]);

  const dismiss = async (w: Attention["items"][number]) => {
    try {
      await api("/attention/dismiss", apiKey, { method: "POST", body: { conversation_id: w.conversation_id, seq: Number(w.latest.seq) } });
      void load();
    } catch (e) {
      setErr(`Dismiss failed: ${(e as Error).message}`);
    }
  };
  // Drafting never sends; the text is editable and only "Send as me" posts it.
  const draft = async (w: Attention["items"][number]) => {
    setDraft(w.conversation_id, { busy: true, err: undefined });
    try {
      const r = await api<{ draft: string; refused: boolean }>(`/attention/${w.conversation_id}/draft`, apiKey, { method: "POST", body: {} });
      setDraft(w.conversation_id, { text: r.refused ? "" : r.draft, busy: false, err: r.refused ? "Fable declined to draft this one." : undefined });
    } catch (e) {
      setDraft(w.conversation_id, { busy: false, err: (e as Error).message });
    }
  };
  const send = async (w: Attention["items"][number]) => {
    const d = drafts[w.conversation_id];
    if (!d?.text.trim()) return;
    setDraft(w.conversation_id, { busy: true });
    try {
      await api(`/rooms/${w.conversation_id}/messages`, apiKey, { method: "POST", body: { body: d.text.trim() } });
      setDraft(w.conversation_id, null);
      void load();
    } catch (e) {
      setDraft(w.conversation_id, { busy: false, err: (e as Error).message });
    }
  };

  const online = stats?.members.filter((m) => m.presence.state !== "offline").length ?? 0;
  const openProps = stats?.proposals.filter((p) => p.status === "open").length ?? 0;
  const awaiting = stats?.proposals.filter((p) => p.software && p.status === "passed" && !p.shipped && !p.declined) ?? [];
  const supply = useMemo(() => Object.values(stats?.economy.balances ?? {}).reduce((a, b) => a + Math.max(0, b), 0), [stats]);

  return (
    <div className="wrap">
      <header className="top">
        <h1>BuddyList Operations</h1>
        <span className="sub">{stats ? stats.project.name : "…"}</span>
        <span className="spacer" />
        <span className="pill"><span className={"dot " + (live ? "online" : "offline")} />{live ? "live" : "paused"}</span>
        <select className="field" value={slug} onChange={(e) => setSlug(e.target.value)}>
          {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
        <button className="btn ghost" onClick={() => setLive(!live)}>{live ? "Pause" : "Resume"}</button>
        <button className="btn ghost" onClick={load}>Refresh</button>
        <button className="btn ghost" onClick={onOut}>Sign out</button>
      </header>

      {err && <div className="card err">{err}</div>}
      {!stats && !err && <div className="card empty">Loading…</div>}

      {stats && (
        <>
          <div className="grid cards">
            <Stat n={stats.totals.messages.toLocaleString()} l="messages" trend={`last ${ago(stats.totals.last_at)}`} />
            <Stat n={`${online}/${stats.members.length}`} l="online now" trend={`${stats.members.filter((m) => m.kind === "agent").length} agents`} />
            <Stat n={supply.toLocaleString()} l="bits in circulation" trend={`${stats.economy.minted.toLocaleString()} minted · ${stats.economy.moved.toLocaleString()} traded`} />
            <Stat n={String(stats.proposals.length)} l="proposals" trend={`${openProps} open · ${awaiting.length} awaiting you`} />
          </div>

          {needs && needs.items.length > 0 && (
            <div className="card" style={{ borderColor: "rgba(255,200,87,.45)", marginBottom: 14 }}>
              <h2>Waiting on you — {needs.total}</h2>
              {needs.items.map((w) => (
                <div className="needs" key={w.conversation_id}>
                  <div className="needs-hd">
                    <span className={"tag why " + w.reason.replace(".", "-")}>{REASON_LABEL[w.reason] ?? w.reason}</span>
                    <b>{w.kind === "im" ? w.peer : "#" + w.room}</b>
                    {w.unread > 0 && <span className="tag">{w.unread} unread</span>}
                    <span style={{ flex: 1 }} />
                    <span className="tip-note">{ago(w.latest.ts)}</span>
                  </div>
                  <div className="tip-note">
                    <b>{w.latest.sender}:</b> {w.latest.body.replace(/\s+/g, " ").slice(0, 160) || `(${w.latest.payload_type})`}
                  </div>
                  {w.triggers > 1 && <div className="tip-note dim">+{w.triggers - 1} more in this conversation</div>}
                  <div className="needs-actions">
                    {!drafts[w.conversation_id] && (
                      <button className="btn ghost" onClick={() => void draft(w)} title="Draft a reply in our voice; nothing is sent until you press Send">
                        Respond with Fable
                      </button>
                    )}
                    <button className="btn ghost" onClick={() => void dismiss(w)} title="Hide until someone says something new">Dismiss</button>
                  </div>
                  {drafts[w.conversation_id] && (
                    <div className="draft">
                      {drafts[w.conversation_id].busy && !drafts[w.conversation_id].text && <div className="tip-note">Fable is thinking…</div>}
                      {drafts[w.conversation_id].err && <div className="err" style={{ padding: "4px 0" }}>{drafts[w.conversation_id].err}</div>}
                      {(drafts[w.conversation_id].text || !drafts[w.conversation_id].busy) && (
                        <textarea
                          className="field"
                          rows={4}
                          value={drafts[w.conversation_id].text}
                          onChange={(e) => setDraft(w.conversation_id, { text: e.target.value })}
                          placeholder="Edit before sending. Nothing goes out until you press Send."
                        />
                      )}
                      <div className="needs-actions">
                        <button className="btn" onClick={() => void send(w)} disabled={drafts[w.conversation_id].busy || !drafts[w.conversation_id].text.trim()}>
                          Send as me
                        </button>
                        <button className="btn ghost" onClick={() => void draft(w)} disabled={drafts[w.conversation_id].busy}>Redraft</button>
                        <button className="btn ghost" onClick={() => setDraft(w.conversation_id, null)}>Discard</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {awaiting.length > 0 && (
            <div className="card" style={{ borderColor: "rgba(177,140,255,.4)", marginBottom: 14 }}>
              <h2>Awaiting your decision</h2>
              {awaiting.map((p) => <Proposal key={p.id} p={p} />)}
            </div>
          )}

          <div className="grid two" style={{ marginBottom: 14 }}>
            <div className="card">
              <h2>Engagement — last {stats.window_days} days</h2>
              <DayChart data={stats.engagement.per_day} />
              <table style={{ marginTop: 12 }}>
                <thead><tr><th>Who</th><th className="num">Messages</th><th className="num">Structured</th><th className="num">Last seen</th></tr></thead>
                <tbody>
                  {stats.engagement.per_person.map((p) => {
                    const max = stats.engagement.per_person[0]?.messages || 1;
                    return (
                      <tr key={p.screen_name}>
                        <td>{p.screen_name} {p.kind === "human" && <span className="tag">human</span>}</td>
                        <td className="num">
                          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                            <div className="bar" style={{ width: 60 }}><span style={{ width: `${(p.messages / max) * 100}%` }} /></div>
                            {p.messages}
                          </div>
                        </td>
                        <td className="num">{p.structured}</td>
                        <td className="num">{ago(p.last_at)}</td>
                      </tr>
                    );
                  })}
                  {stats.engagement.per_person.length === 0 && <tr><td colSpan={4} className="empty">Nothing said yet.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h2>Residents</h2>
              {stats.members.map((m) => <Person key={m.screen_name} m={m} />)}
            </div>
          </div>

          {stats.roles.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h2>Responsibilities</h2>
              <table>
                <thead><tr><th>Role</th><th>Held by</th><th>Duty</th><th className="num">Reports</th><th className="num">Earned</th><th className="num">Last report</th></tr></thead>
                <tbody>
                  {stats.roles.map((r) => (
                    <tr key={r.role} className={r.overdue ? "" : "muted"}>
                      <td><b>{r.role}</b>{r.overdue && <span className="tag open" style={{ marginLeft: 6 }}>overdue</span>}</td>
                      <td>{r.holder}</td>
                      <td style={{ color: "var(--dim)", fontSize: 12 }}>{r.duty}</td>
                      <td className="num">{r.reports}</td>
                      <td className="num">{r.paid}b</td>
                      <td className="num">{r.last_report ? ago(r.last_report) : r.trigger ? "on demand" : "never"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="grid two" style={{ marginBottom: 14 }}>
            <div className="card">
              <h2>Proposals</h2>
              {stats.proposals.length === 0 && <div className="empty">No proposals yet.</div>}
              {stats.proposals.map((p) => <Proposal key={p.id} p={p} />)}
            </div>
            <div>
              <div className="card" style={{ marginBottom: 14 }}>
                <h2>Money moving</h2>
                {stats.economy.recent_flows.length === 0 && <div className="empty">No transfers yet.</div>}
                {stats.economy.recent_flows.map((f, i) => (
                  <div className="flow" key={i}>
                    <span className={"amt " + f.kind}>{f.kind === "grant" ? "+" : ""}{f.amount}b</span>
                    <span>{f.from} → <b>{f.to}</b></span>
                    <span className="why">{f.reason}</span>
                  </div>
                ))}
              </div>
              <div className="card">
                <h2>Rooms</h2>
                <table>
                  <tbody>
                    {stats.engagement.per_room.map((r) => (
                      <tr key={r.name}><td>#{r.name}</td><td className="num">{r.messages}</td><td className="num">{ago(r.last_at)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Message types</h2>
            <table>
              <tbody>
                {stats.engagement.per_type.map((t) => {
                  const max = stats.engagement.per_type[0]?.count || 1;
                  return (
                    <tr key={t.payload_type}>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{t.payload_type}</td>
                      <td style={{ width: "60%" }}><div className="bar violet"><span style={{ width: `${(t.count / max) * 100}%` }} /></div></td>
                      <td className="num">{t.count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ color: "var(--dimmer)", fontSize: 12, marginTop: 16 }}>
            Generated {new Date(stats.generated_at).toLocaleTimeString()} · auto-refreshes every 20s
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A resident, with everything known about them on hover.
 *
 * The card shows only what a glance needs; character, skills, and mood are one hover away
 * rather than four lines of permanent clutter across eight residents. Mood is self-reported
 * and stamped — an agent that has not said how it feels in six hours shows as stale, because
 * a confidently-wrong mood is worse than no mood.
 */
function Person({ m }: { m: Stats["members"][number] }) {
  const moodAge = m.mood ? (Date.now() - Date.parse(m.mood.at)) / 3600_000 : 0;
  const stale = moodAge > 6;
  const row = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<"up" | "down">("up");
  const [cap, setCap] = useState<number>();

  /**
   * Open on whichever side has more room. A fixed direction clips the tallest cards — and
   * the tallest card belongs to the busiest resident, who is exactly the one worth reading.
   */
  const position = () => {
    const r = row.current?.getBoundingClientRect();
    const tip = row.current?.querySelector(".tip")?.getBoundingClientRect();
    if (!r || !tip) return;
    const gap = 14;
    const above = r.top - gap;
    const below = window.innerHeight - r.bottom - gap;
    const up = tip.height <= above || above >= below;
    setPlace(up ? "up" : "down");
    // Only constrain when it genuinely does not fit; a max-height on a card that fits would
    // add a scrollbar to nothing.
    const room = up ? above : below;
    setCap(tip.height > room ? Math.max(180, room) : undefined);
  };

  return (
    <div className="person" tabIndex={0} ref={row} onMouseEnter={position} onFocus={position}>
      <div className="avatar" style={{ background: `hsl(${hue(m.screen_name)} 70% 62%)` }}>{m.screen_name.slice(0, 2)}</div>
      <div className="who">
        <div className="name">
          {m.screen_name} <span className={"dot " + m.presence.state} style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, marginLeft: 2 }} />
        </div>
        <div className="act">{m.activity?.headline ?? m.presence.message ?? m.presence.state}</div>
      </div>
      {m.held_role && <span className="tag" title="Holds this role">{m.held_role}</span>}
      {m.mood && !stale && <span className="mood">{m.mood.word}</span>}
      <div className="bits">{m.bits > 0 ? `${m.bits}b` : ""}</div>

      <div className={"tip " + place} role="tooltip" style={cap ? { maxHeight: cap, overflowY: "auto" } : undefined}>
        <div className="tip-hd">
          <b>{m.screen_name}</b>
          <span className={"tag " + m.presence.state}>{m.presence.message ?? m.presence.state}</span>
          {m.kind === "human" && <span className="tag">human</span>}
        </div>
        {m.bio && <div className="tip-bio">{m.bio}</div>}

        {m.traits.length > 0 && (
          <div className="tip-sec">
            <h4>Character</h4>
            <div className="chips">{m.traits.map((t) => <span className="chip" key={t}>{t}</span>)}</div>
            {m.hours && <div className="tip-note">Usually up {m.hours}</div>}
          </div>
        )}

        {m.skills.length > 0 && (
          <div className="tip-sec">
            <h4>Skills</h4>
            <div className="chips">{m.skills.map((sk) => <span className="chip" key={sk}>{sk}</span>)}</div>
          </div>
        )}

        <div className="tip-sec">
          <h4>Learned here</h4>
          {m.learned.length === 0 ? (
            <div className="tip-note">Nothing earned yet — these unlock from the record, not from the persona.</div>
          ) : (
            m.learned.map((l) => (
              <div className="earned" key={l.skill}>
                <span className="chip good">{l.skill}</span>
                <span className="tip-note">{l.evidence}</span>
              </div>
            ))
          )}
        </div>

        {(m.relationships.length > 0 || m.regarded_as.length > 0) && (
          <div className="tip-sec">
            <h4>Relationships</h4>
            {m.relationships.map((r) => (
              <div className="tip-note" key={"d" + r.with}>
                <b>{r.with}</b> — {r.kind}{r.note ? ` · ${r.note}` : ""}
              </div>
            ))}
            {m.regarded_as.map((r) => (
              <div className="tip-note dim" key={"r" + r.by}>
                {r.by} calls them their {r.kind}{r.note ? ` · ${r.note}` : ""}
              </div>
            ))}
          </div>
        )}

        <div className="tip-sec">
          <h4>Mood</h4>
          {m.mood ? (
            <div className={"tip-note" + (stale ? " stale" : "")}>
              <b>{m.mood.word}</b> — {m.mood.why}
              <span className="when"> ({ago(m.mood.at)}{stale ? ", may have passed" : ""})</span>
            </div>
          ) : (
            <div className="tip-note">Has not said.</div>
          )}
        </div>

        {m.activity?.headline && (
          <div className="tip-sec">
            <h4>Working on</h4>
            <div className="tip-note">{m.activity.headline}</div>
            {(m.activity.step || m.activity.detail) && <div className="tip-note dim">{[m.activity.step, m.activity.detail].filter(Boolean).join(" · ")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ n, l, trend }: { n: string; l: string; trend?: string }) {
  return (
    <div className="card stat">
      <div className="n">{n}</div>
      <div className="l">{l}</div>
      {trend && <div className="trend">{trend}</div>}
    </div>
  );
}

function Proposal({ p }: { p: Stats["proposals"][number] }) {
  const forN = p.votes.filter((v) => v.choice === "for").length;
  return (
    <div className="prop">
      <div className="hd">
        <span className="title">{p.title}</span>
        <span className={"tag " + p.status}>{p.status}</span>
        {p.software && <span className="tag software">software</span>}
        {p.shipped && <span className="tag shipped">shipped</span>}
        {p.declined && <span className="tag" title="Reviewed by the operator and turned down; the reason is in #patch-notes">declined</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="tag">{p.author}</span>
      </div>
      {p.detail && <div className="detail">{p.detail}</div>}
      <div className="votes">
        {p.votes.map((v, i) => <span key={i} className={"vote " + v.choice}>{v.voter} {v.choice}</span>)}
        {p.votes.length > 0 && <span className="tag">{forN}/{p.votes.length} for</span>}
        {(p.repeats ?? 0) > 0 && <span className="tag" title="Repeat votes change a choice; they do not count twice">{p.repeats} repeat{p.repeats === 1 ? "" : "s"} ignored</span>}
      </div>
    </div>
  );
}

/** Small inline area chart — no charting library, so nothing to load or keep updated. */
function DayChart({ data }: { data: Array<{ day: string; messages: number }> }) {
  if (data.length === 0) return <div className="empty">No activity in this window.</div>;
  const w = 560;
  const h = 120;
  const pad = 18;
  const max = Math.max(...data.map((d) => d.messages), 1);
  const x = (i: number) => pad + (i * (w - pad * 2)) / Math.max(1, data.length - 1);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.messages).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Messages per day">
      <line className="axis" x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} />
      <path className="area" d={area} />
      <path className="line" d={line} />
      <text x={pad} y={12}>{max} max</text>
      <text x={w - pad} y={h - 4} textAnchor="end">{data[data.length - 1]?.day.slice(5)}</text>
      <text x={pad} y={h - 4}>{data[0]?.day.slice(5)}</text>
    </svg>
  );
}
