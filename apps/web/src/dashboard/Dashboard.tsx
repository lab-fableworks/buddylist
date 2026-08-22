import { useCallback, useEffect, useMemo, useState } from "react";

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
    status: string; shipped: boolean; votes: Array<{ voter: string; choice: string }>;
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
  }>;
}

const api = async <T,>(path: string, key: string): Promise<T> => {
  const r = await fetch("/api" + path, { headers: { authorization: `Bearer ${key}` } });
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
  const [err, setErr] = useState<string>();
  const [live, setLive] = useState(true);

  useEffect(() => {
    void api<Array<{ slug: string; name: string }>>("/stats", apiKey).then((p) => {
      setProjects(p);
      if (p.length && !p.some((x) => x.slug === slug)) setSlug(p[0].slug);
    }).catch((e) => setErr((e as Error).message));
  }, [apiKey, slug]);

  const load = useCallback(async () => {
    try {
      setStats(await api<Stats>(`/stats/${slug}?days=14`, apiKey));
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

  const online = stats?.members.filter((m) => m.presence.state !== "offline").length ?? 0;
  const openProps = stats?.proposals.filter((p) => p.status === "open").length ?? 0;
  const awaiting = stats?.proposals.filter((p) => p.software && p.status === "passed" && !p.shipped) ?? [];
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
  return (
    <div className="person" tabIndex={0}>
      <div className="avatar" style={{ background: `hsl(${hue(m.screen_name)} 70% 62%)` }}>{m.screen_name.slice(0, 2)}</div>
      <div className="who">
        <div className="name">
          {m.screen_name} <span className={"dot " + m.presence.state} style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, marginLeft: 2 }} />
        </div>
        <div className="act">{m.activity?.headline ?? m.presence.message ?? m.presence.state}</div>
      </div>
      {m.mood && !stale && <span className="mood">{m.mood.word}</span>}
      <div className="bits">{m.bits > 0 ? `${m.bits}b` : ""}</div>

      <div className="tip" role="tooltip">
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
        <span className="spacer" style={{ flex: 1 }} />
        <span className="tag">{p.author}</span>
      </div>
      {p.detail && <div className="detail">{p.detail}</div>}
      <div className="votes">
        {p.votes.map((v, i) => <span key={i} className={"vote " + v.choice}>{v.voter} {v.choice}</span>)}
        {p.votes.length > 0 && <span className="tag">{forN}/{p.votes.length} for</span>}
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
