import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BuddyList, type Message, type Presence } from "@buddylist/sdk";
import { WindowManager, useWM } from "./wm";
import { sfx, isMuted, setMuted } from "./sounds";

type Buddy = { screen_name: string; kind: string; presence: Presence; capabilities: Record<string, unknown>; warn_level?: number; uin?: number; profile?: { bio?: string } };
type Group = { name: string; buddies: Buddy[] };
type Conv = { id: string; kind: "im" | "room"; name: string | null; peer: string | null; last_seq: number; last_read_seq: number };

// ---------------- sign-on ----------------
export function App() {
  const [client, setClient] = useState<BuddyList>();
  const [me, setMe] = useState<{ screen_name: string; uin: number }>();
  if (!client || !me)
    return (
      <WindowManager fixed={<SignOn onSignedOn={(c, m) => (setClient(c), setMe(m))} />} />
    );
  return (
    <WindowManager fixed={<Session client={client} me={me} onSignOff={() => (client.close(), setClient(undefined))} />} />
  );
}

function SignOn({ onSignedOn }: { onSignedOn: (c: BuddyList, me: { screen_name: string; uin: number }) => void }) {
  const [key, setKey] = useState(localStorage.getItem("bl.key") ?? "");
  const [url, setUrl] = useState(localStorage.getItem("bl.url") ?? window.location.origin);
  const [save, setSave] = useState(!!localStorage.getItem("bl.key"));
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const c = new BuddyList({ url, apiKey: key.trim() });
      await c.connect();
      if (save) {
        localStorage.setItem("bl.key", key.trim());
        localStorage.setItem("bl.url", url);
      } else localStorage.removeItem("bl.key");
      sfx.doorOpen();
      onSignedOn(c, c.me!);
    } catch (e) {
      setErr((e as Error).message);
      sfx.uhoh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="win active signon" role="dialog" aria-label="Sign On">
      <div className="titlebar"><span className="ico">🟡</span><span className="title">Sign On</span></div>
      <div className="body" style={{ padding: 10 }}>
        <div className="runner">🏃</div>
        <div className="logo">BuddyList</div>
        <label>Server</label>
        <input className="field" value={url} onChange={(e) => setUrl(e.target.value)} />
        <label>API Key</label>
        <input className="field" type="password" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} autoFocus />
        <label className="row"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save key</label>
        {err && <div className="error">⚠ {err}</div>}
        <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
          <button className="btn" onClick={go} disabled={busy || !key}>{busy ? "Signing On…" : "Sign On"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------- session ----------------
function Session({ client, me, onSignOff }: { client: BuddyList; me: { screen_name: string; uin: number }; onSignOff: () => void }) {
  const wm = useWM();
  const [groups, setGroups] = useState<Group[]>([]);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [presence, setPresence] = useState<Presence>({ state: "online" });
  const [muted, setMutedState] = useState(isMuted());
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<"buddies" | "rooms">("buddies");
  const openConvRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const [g, c] = await Promise.all([client.buddies(), client.inbox()]);
    setGroups(g);
    setConvs(c);
  }, [client]);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // presence / buddy events
  useEffect(() => {
    const offs = [
      client.on("presence", (f) => {
        setGroups((gs) => gs.map((g) => ({ ...g, buddies: g.buddies.map((b) => (b.screen_name === f.data.screen_name ? { ...b, presence: f.data.presence } : b)) })));
      }),
      client.on("buddy.signon", () => sfx.doorOpen()),
      client.on("buddy.signoff", () => sfx.doorClose()),
      client.on("mention", () => sfx.ping()),
      client.on("warn", (f) => (sfx.uhoh(), alert(`Warning level is now ${Math.round(f.data.level)}%: ${f.data.reason}`))),
      client.on("message", (f) => {
        const m = f.data;
        if (m.sender === me.screen_name) return;
        if (!openConvRef.current.has(m.conversation_id)) {
          setUnread((u) => ({ ...u, [m.conversation_id]: (u[m.conversation_id] ?? 0) + 1 }));
          sfx.im();
          // auto-open IMs like the real thing
          void client.inbox().then((inbox) => {
            setConvs(inbox);
            const c = inbox.find((x) => x.id === m.conversation_id);
            if (c?.kind === "im") openConversation(c);
          });
        }
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [client]);

  const openConversation = useCallback(
    (c: Conv) => {
      const title = c.kind === "im" ? `${c.peer} — Instant Message` : `#${c.name} — Chat Room`;
      openConvRef.current.add(c.id);
      setUnread((u) => ({ ...u, [c.id]: 0 }));
      wm.open({
        id: "conv:" + c.id,
        title,
        icon: c.kind === "im" ? "💬" : "🏠",
        className: "convo",
        render: () => <Conversation client={client} me={me} conv={c} onClosed={() => openConvRef.current.delete(c.id)} />,
      });
    },
    [client, me, wm],
  );

  const openIM = async (name: string) => {
    const r = await client.api<{ conversation_id: string }>("GET", `/ims/${name}`);
    openConversation({ id: r.conversation_id, kind: "im", name: null, peer: name, last_seq: 0, last_read_seq: 0 });
  };
  const openInfo = async (name: string) => {
    const u = await client.api<Buddy>("GET", `/users/${name}`);
    wm.open({ id: "info:" + name, title: `${name} — Info`, icon: "ℹ", className: "dialog", render: ({ close }) => <Info u={u} onIM={() => (close(), openIM(name))} onWarn={() => client.api("POST", `/users/${name}/warn`).then(refresh)} /> });
  };
  const setAway = () => {
    wm.open({
      id: "away",
      title: "Away Message",
      icon: "🚪",
      className: "dialog",
      render: ({ close }) => (
        <AwayDialog
          onSet={(state, msg) => {
            void client.setPresence(state, msg);
            setPresence({ state, message: msg });
            close();
          }}
        />
      ),
    });
  };
  const openProjects = () => wm.open({ id: "projects", title: "Projects & Rooms", icon: "📁", className: "dialog", render: () => <Projects client={client} onOpenRoom={(c) => (refresh(), openConversation(c))} /> });
  const openNewAgent = () => wm.open({ id: "newagent", title: "Register Agent", icon: "🤖", className: "dialog", render: ({ close }) => <NewAgent client={client} onDone={() => (refresh(), close())} /> });
  const openSearch = () => wm.open({ id: "search", title: "Find Messages", icon: "🔍", className: "dialog", render: () => <Search client={client} /> });

  const rooms = convs.filter((c) => c.kind === "room");
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);

  return (
    <div className="win active buddylist" role="dialog" aria-label="Buddy List">
      <div className="titlebar"><span className="ico">🟡</span><span className="title">{me.screen_name}'s Buddy List{totalUnread ? ` (${totalUnread})` : ""}</span></div>
      <div className="menubar">
        <span onClick={openProjects}>Projects</span>
        <span onClick={openNewAgent}>Agents</span>
        <span onClick={openSearch}>Find</span>
        <span onClick={() => (setMuted(!muted), setMutedState(!muted))}>{muted ? "🔇" : "🔊"}</span>
        <span onClick={() => (sfx.doorClose(), onSignOff())}>Sign Off</span>
      </div>
      <div className="body">
        <div className="row" style={{ gap: 6 }}>
          <span className={"dot " + presence.state} style={{ width: 10, height: 10, borderRadius: 5, border: "1px solid #333", display: "inline-block" }} />
          <b>{me.screen_name}</b>
          <span style={{ color: "#555" }}>#{me.uin}</span>
        </div>
        {presence.state !== "online" && <div style={{ fontStyle: "italic", color: "#555", fontSize: 11 }}>{presence.state}{presence.message ? `: ${presence.message}` : ""}</div>}
        <div className="tabs">
          <span className={"tab" + (tab === "buddies" ? " on" : "")} onClick={() => setTab("buddies")}>Buddies</span>
          <span className={"tab" + (tab === "rooms" ? " on" : "")} onClick={() => setTab("rooms")}>Rooms{rooms.some((r) => unread[r.id]) ? " •" : ""}</span>
        </div>
        <div className="sunken tree">
          {tab === "buddies" ? (
            groups.length === 0 ? (
              <div style={{ padding: 6, color: "#666" }}>No buddies yet. Join a project or add agents.</div>
            ) : (
              groups.map((g) => <BuddyGroup key={g.name} g={g} onIM={openIM} onInfo={openInfo} />)
            )
          ) : (
            rooms.map((r) => (
              <div key={r.id} className="buddy" onDoubleClick={() => openConversation(r)} style={{ paddingLeft: 6 }}>
                <span className="name">🏠 #{r.name}</span>
                {unread[r.id] ? <span className="badge">{unread[r.id]}</span> : null}
              </div>
            ))
          )}
        </div>
        <div className="row">
          <button className="btn" onClick={setAway}>Away</button>
          <button className="btn" onClick={() => (client.setPresence("online"), setPresence({ state: "online" }))}>Back</button>
          <button className="btn" onClick={() => (client.setPresence("invisible"), setPresence({ state: "invisible" }))}>Invisible</button>
        </div>
      </div>
      <div className="statusbar"><span className="cell">{groups.reduce((n, g) => n + g.buddies.filter((b) => b.presence.state !== "offline").length, 0)} online</span><span className="cell">{rooms.length} rooms</span></div>
    </div>
  );
}

function BuddyGroup({ g, onIM, onInfo }: { g: Group; onIM: (n: string) => void; onInfo: (n: string) => void }) {
  const [open, setOpen] = useState(true);
  const online = g.buddies.filter((b) => b.presence.state !== "offline");
  const sorted = [...g.buddies].sort((a, b) => (a.presence.state === "offline" ? 1 : 0) - (b.presence.state === "offline" ? 1 : 0) || a.screen_name.localeCompare(b.screen_name));
  return (
    <div>
      <div className="group" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {g.name} <span className="count">({online.length}/{g.buddies.length})</span></div>
      {open &&
        sorted.map((b) => (
          <div key={b.screen_name} className={"buddy " + b.presence.state} onDoubleClick={() => onIM(b.screen_name)} onContextMenu={(e) => (e.preventDefault(), onInfo(b.screen_name))} title={b.presence.message ? `${b.presence.state}: ${b.presence.message}` : b.presence.state}>
            <span className={"dot " + b.presence.state} />
            <span className="name">{b.screen_name}</span>
            {b.kind === "agent" && <span className="badge">{String(b.capabilities.model ?? "bot").replace(/^claude-/, "")}</span>}
          </div>
        ))}
    </div>
  );
}

// ---------------- conversation window ----------------
function Conversation({ client, me, conv, onClosed }: { client: BuddyList; me: { screen_name: string }; conv: Conv; onClosed: () => void }) {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [members, setMembers] = useState<Array<{ screen_name: string; kind: string; presence: Presence }>>([]);
  const [topic, setTopic] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    void client.history(conv.id, { limit: 100 }).then((h) => {
      setMsgs(h);
      if (h.length) client.markRead(conv.id, h[h.length - 1].seq);
    });
    if (conv.kind === "room")
      void client.api<{ topic: string; members: typeof members }>("GET", `/rooms/${conv.id}`).then((r) => (setMembers(r.members), setTopic(r.topic)));
    const offs = [
      client.on("message", (f) => {
        if (f.conversation_id !== conv.id) return;
        setMsgs((m) => (m.some((x) => x.id === f.data.id) ? m : [...m, f.data]));
        client.markRead(conv.id, f.seq);
      }),
      client.on("message.edit", (f) => {
        if (f.conversation_id === conv.id) setMsgs((m) => m.map((x) => (x.id === f.data.id ? f.data : x)));
      }),
      client.on("message.delete", (f) => {
        if (f.conversation_id === conv.id) setMsgs((m) => m.map((x) => (x.id === f.data.id ? { ...x, deleted_at: f.ts, body: "" } : x)));
      }),
      client.on("typing", (f) => {
        if (f.conversation_id === conv.id && f.data.screen_name !== me.screen_name) setTyping((t) => ({ ...t, [f.data.screen_name]: Date.now() }));
      }),
      client.on("presence", (f) => setMembers((ms) => ms.map((m) => (m.screen_name === f.data.screen_name ? { ...m, presence: f.data.presence } : m)))),
    ];
    const tick = setInterval(() => setTyping((t) => Object.fromEntries(Object.entries(t).filter(([, ts]) => Date.now() - ts < 4000))), 1000);
    return () => (offs.forEach((o) => o()), clearInterval(tick), onClosed());
  }, [conv.id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [msgs]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    try {
      if (body.startsWith("/topic ") && conv.kind === "room") {
        await client.api("PUT", `/rooms/${conv.id}/topic`, { topic: body.slice(7) });
        setTopic(body.slice(7));
        return;
      }
      if (body.startsWith("/invite ") && conv.kind === "room") {
        await client.api("POST", `/rooms/${conv.id}/invite`, { screen_name: body.slice(8).trim() });
        return;
      }
      if (conv.kind === "im") await client.im(conv.peer!, body);
      else await client.send(conv.id, body);
      sfx.sent();
    } catch (e) {
      sfx.uhoh();
      setMsgs((m) => [...m, { id: "err" + Date.now(), conversation_id: conv.id, seq: -1, sender: "", body: (e as Error).message, payload_type: "x-system", payload: null, reply_to: null, edited_at: null, deleted_at: null, ts: new Date().toISOString() }]);
    }
  };
  const onType = (v: string) => {
    setText(v);
    if (Date.now() - lastTyping.current > 2500) {
      lastTyping.current = Date.now();
      client.typing(conv.id);
    }
  };
  const respond = (m: Message, type: string, payload: Record<string, unknown>) => {
    const send = conv.kind === "im" ? (i: object) => client.im(conv.peer!, i) : (i: object) => client.send(conv.id, i);
    return send({ payload_type: type, payload, reply_to: m.id });
  };

  const typers = Object.keys(typing);
  return (
    <div className="body">
      {conv.kind === "room" && topic && <div style={{ fontSize: 11, color: "#333" }}>Topic: {topic}</div>}
      <div className="split">
        <div className="sunken log" ref={logRef}>
          {msgs.map((m) => <MessageView key={m.id} m={m} mine={m.sender === me.screen_name} onRespond={respond} />)}
        </div>
        {conv.kind === "room" && (
          <div className="sunken members">
            {members.map((m) => (
              <div key={m.screen_name} className={"buddy " + m.presence.state} style={{ fontSize: 11 }}>
                <span className={"dot " + m.presence.state} /><span className="name">{m.screen_name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="typing">{typers.length ? `${typers.join(", ")} ${typers.length > 1 ? "are" : "is"} typing…` : ""}</div>
      <textarea className="field composer" value={text} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())} placeholder={conv.kind === "room" ? "Message… (/topic, /invite)" : "Message…"} />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={send}>Send</button>
      </div>
    </div>
  );
}

function MessageView({ m, mine, onRespond }: { m: Message; mine: boolean; onRespond: (m: Message, type: string, payload: Record<string, unknown>) => Promise<unknown> }) {
  const time = new Date(m.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (m.payload_type === "x-system") return <div className="msg sys">⚠ {m.body}</div>;
  if (m.deleted_at) return <div className="msg deleted"><span className="time">{time}</span>{m.sender} deleted a message</div>;
  const p = m.payload as Record<string, unknown> | null;
  const hasCard = m.payload_type !== "text" && p;
  return (
    <div className={"msg " + (mine ? "me" : "them")}>
      <span className="time">{time}</span>
      <span className="who">{m.sender}:</span> {m.body}
      {m.edited_at && <span className="edited"> (edited)</span>}
      {hasCard && (
        <div className="card">
          <div className="ctitle">
            📎 {m.payload_type}
            {!mine && m.payload_type === "task.request" && (
              <>
                <button className="btn" onClick={() => onRespond(m, "task.accept", { task_id: p.task_id })}>Accept</button>
                <button className="btn" onClick={() => onRespond(m, "task.decline", { task_id: p.task_id, reason: "declined via client" })}>Decline</button>
              </>
            )}
          </div>
          {JSON.stringify(p, null, 1).replace(/^\{\n|\n\}$/g, "")}
        </div>
      )}
    </div>
  );
}

// ---------------- dialogs ----------------
function AwayDialog({ onSet }: { onSet: (s: "away" | "busy", m: string) => void }) {
  const presets = ["brb", "Running tests…", "Deep in a refactor", "Waiting on CI", "Out to lunch", "Gone fishin'"];
  const [msg, setMsg] = useState(presets[0]);
  const [state, setState] = useState<"away" | "busy">("away");
  return (
    <div className="body">
      <select className="field" size={5} onChange={(e) => setMsg(e.target.value)}>{presets.map((p) => <option key={p}>{p}</option>)}</select>
      <input className="field" value={msg} onChange={(e) => setMsg(e.target.value)} />
      <label className="row"><input type="radio" checked={state === "away"} onChange={() => setState("away")} /> Away <input type="radio" checked={state === "busy"} onChange={() => setState("busy")} /> Busy</label>
      <div className="actions"><button className="btn" onClick={() => onSet(state, msg)}>I'm Away</button></div>
    </div>
  );
}

function Info({ u, onIM, onWarn }: { u: Buddy; onIM: () => void; onWarn: () => void }) {
  const c = u.capabilities;
  return (
    <div className="body">
      <dl className="info">
        <dt>Screen name</dt><dd><b>{u.screen_name}</b> <span style={{ color: "#666" }}>#{u.uin}</span></dd>
        <dt>Type</dt><dd>{u.kind}</dd>
        <dt>Status</dt><dd>{u.presence.state}{u.presence.message ? ` — ${u.presence.message}` : ""}</dd>
        <dt>Warning</dt><dd>{Math.round(u.warn_level ?? 0)}%</dd>
        {c.model ? <><dt>Model</dt><dd>{String(c.model)}</dd></> : null}
        {c.operator ? <><dt>Operator</dt><dd>{String(c.operator)}</dd></> : null}
        {Array.isArray(c.skills) && c.skills.length ? <><dt>Skills</dt><dd>{c.skills.join(", ")}</dd></> : null}
        {Array.isArray(c.accepts) && c.accepts.length ? <><dt>Accepts</dt><dd>{c.accepts.join(", ")}</dd></> : null}
        {Array.isArray(c.repos) && c.repos.length ? <><dt>Repos</dt><dd>{c.repos.join(", ")}</dd></> : null}
        {u.profile?.bio ? <><dt>Bio</dt><dd>{u.profile.bio}</dd></> : null}
      </dl>
      <div className="actions"><button className="btn" onClick={onWarn}>Warn</button><button className="btn" onClick={onIM}>Send IM</button></div>
    </div>
  );
}

function Projects({ client, onOpenRoom }: { client: BuddyList; onOpenRoom: (c: Conv) => void }) {
  const [list, setList] = useState<Array<{ slug: string; name: string; role: string }>>([]);
  const [sel, setSel] = useState<Awaited<ReturnType<BuddyList["project"]>>>();
  const [slug, setSlug] = useState("");
  const [member, setMember] = useState("");
  const [room, setRoom] = useState("");
  const load = useCallback(() => client.projects().then(setList), [client]);
  useEffect(() => void load(), [load]);
  const pick = (s: string) => client.project(s).then(setSel);
  return (
    <div className="body">
      <div className="row">
        <select className="field" onChange={(e) => pick(e.target.value)} value={sel?.slug ?? ""}>
          <option value="">— select project —</option>
          {list.map((p) => <option key={p.slug} value={p.slug}>{p.name} ({p.role})</option>)}
        </select>
      </div>
      <div className="row">
        <input className="field" placeholder="new-project-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
        <button className="btn" onClick={() => client.api("POST", "/projects", { slug, name: slug }).then(() => (setSlug(""), load()))} disabled={!slug}>Create</button>
      </div>
      {sel && (
        <>
          <div className="sunken" style={{ padding: 4, maxHeight: 120 }}>
            <b>Members</b>
            {sel.members.map((m) => <div key={m.screen_name}>{m.screen_name} <span style={{ color: "#666" }}>({m.role})</span></div>)}
          </div>
          <div className="row">
            <input className="field" placeholder="add member screen name" value={member} onChange={(e) => setMember(e.target.value)} />
            <button className="btn" onClick={() => client.api("POST", `/projects/${sel.slug}/members`, { screen_name: member }).then(() => (setMember(""), pick(sel.slug)))} disabled={!member}>Add</button>
          </div>
          <div className="sunken" style={{ padding: 4, maxHeight: 120 }}>
            <b>Rooms</b> (double-click to open)
            {sel.rooms.map((r) => (
              <div key={r.id} onDoubleClick={() => client.joinRoom(r.id).catch(() => {}).then(() => onOpenRoom({ id: r.id, kind: "room", name: r.name, peer: null, last_seq: 0, last_read_seq: 0 }))}>🏠 #{r.name} <span style={{ color: "#666" }}>{r.topic}</span></div>
            ))}
          </div>
          <div className="row">
            <input className="field" placeholder="new-room-name" value={room} onChange={(e) => setRoom(e.target.value)} />
            <button className="btn" onClick={() => client.api("POST", `/projects/${sel.slug}/rooms`, { name: room }).then(() => (setRoom(""), pick(sel.slug)))} disabled={!room}>Create</button>
          </div>
        </>
      )}
    </div>
  );
}

function NewAgent({ client, onDone }: { client: BuddyList; onDone: () => void }) {
  const [name, setName] = useState("");
  const [skills, setSkills] = useState("");
  const [accepts, setAccepts] = useState("task.request");
  const [model, setModel] = useState("claude-fable-5");
  const [result, setResult] = useState<{ api_key: string; screen_name: string }>();
  const [err, setErr] = useState<string>();
  if (result)
    return (
      <div className="body">
        <div>Agent <b>{result.screen_name}</b> registered. Its API key (shown once):</div>
        <textarea className="field" readOnly value={result.api_key} rows={3} onFocus={(e) => e.target.select()} />
        <div className="actions"><button className="btn" onClick={onDone}>Done</button></div>
      </div>
    );
  return (
    <div className="body">
      <input className="field" placeholder="ScreenName" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="field" placeholder="model" value={model} onChange={(e) => setModel(e.target.value)} />
      <input className="field" placeholder="skills, comma separated" value={skills} onChange={(e) => setSkills(e.target.value)} />
      <input className="field" placeholder="accepts payload types, comma separated" value={accepts} onChange={(e) => setAccepts(e.target.value)} />
      {err && <div style={{ color: "#c00" }}>{err}</div>}
      <div className="actions">
        <button className="btn" disabled={!name} onClick={() => client.api<{ api_key: string; screen_name: string }>("POST", "/agents", { screen_name: name, capabilities: { model, skills: split(skills), accepts: split(accepts) } }).then(setResult).catch((e) => setErr(e.message))}>Register</button>
      </div>
    </div>
  );
}
const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function Search({ client }: { client: BuddyList }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Message[]>([]);
  return (
    <div className="body">
      <div className="row">
        <input className="field" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && client.search(q).then(setRes)} placeholder="search messages…" autoFocus />
        <button className="btn" onClick={() => client.search(q).then(setRes)}>Find</button>
      </div>
      <div className="sunken" style={{ height: 200, padding: 4 }}>
        {res.map((m) => <div key={m.id} className="msg"><span className="time">{new Date(m.ts).toLocaleString()}</span><b>{m.sender}:</b> {m.body}</div>)}
        {!res.length && <div style={{ color: "#666" }}>No results.</div>}
      </div>
    </div>
  );
}

export default App;
// keep React import referenced for classic runtimes
void React;
void useMemo;
