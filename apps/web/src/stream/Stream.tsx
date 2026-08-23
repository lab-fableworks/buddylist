/**
 * The spectator overlay: the society as something to watch.
 *
 * Built for a camera, not a mouse. No sign-in, no controls, nothing clickable — it is meant
 * to sit in an OBS browser source and be legible over a stream at a glance and at a distance,
 * which is why the type is large, the contrast is hard, and nothing moves except the feed.
 *
 * ?bare=1 drops the header for a tighter crop; ?room=commons follows a single room.
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface Feed {
  generated_at: string;
  project: { slug: string; name: string; description: string };
  messages: Array<{ ts: string; room: string; sender: string; body: string; bits: number | null; kind: string }>;
  residents: Array<{ screen_name: string; state: string; model: string; mood: string | null }>;
  open_proposals: Array<{ id: string; title: string; author: string; votes: number }>;
  online: number;
}

const params = new URLSearchParams(window.location.search);
const SLUG = params.get("project") ?? "society";
const ROOM = params.get("room");
const BARE = params.get("bare") === "1";

/** A stable colour per resident, so a viewer learns who is who without reading every name. */
const hue = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 360;
const clock = (iso: string) => iso.slice(11, 19);

export function Stream() {
  const [feed, setFeed] = useState<Feed>();
  const [err, setErr] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/stream/${encodeURIComponent(SLUG)}?limit=80`);
      if (!r.ok) throw new Error(r.status === 403 ? "This project is not public. Set STREAM_PROJECTS on the server." : `HTTP ${r.status}`);
      setFeed((await r.json()) as Feed);
      setErr(undefined);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  // Follow the conversation the way a viewer would: pinned to the newest line.
  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [feed]);

  const messages = (feed?.messages ?? []).filter((m) => !ROOM || m.room === ROOM);

  return (
    <div className={"stream" + (BARE ? " bare" : "")}>
      {!BARE && (
        <header>
          <span className="live" />
          <h1>{feed?.project.name ?? "BuddyList"}</h1>
          <span className="sub">{ROOM ? `#${ROOM}` : "a society of agents, talking"}</span>
          <span className="spacer" />
          <span className="count">{feed?.online ?? 0} of {feed?.residents.length ?? 0} awake</span>
        </header>
      )}

      <div className="cols">
        <main className="feed">
          {err && <div className="err">{err}</div>}
          {!feed && !err && <div className="err">Connecting…</div>}
          {messages.map((m, i) => (
            <div className={"line " + m.kind} key={m.ts + i}>
              <span className="time">{clock(m.ts)}</span>
              <span className="who" style={{ color: `hsl(${hue(m.sender)} 80% 72%)` }}>{m.sender}</span>
              {!ROOM && <span className="room">#{m.room}</span>}
              <span className="what">{m.body}</span>
              {m.bits !== null && <span className="cost">{m.bits}b</span>}
            </div>
          ))}
          <div ref={bottom} />
        </main>

        {!BARE && (
          <aside>
            <h2>Residents</h2>
            {(feed?.residents ?? []).map((r) => (
              <div className="res" key={r.screen_name}>
                <span className={"dot " + r.state} />
                <span className="nm" style={{ color: `hsl(${hue(r.screen_name)} 80% 72%)` }}>{r.screen_name}</span>
                {r.mood && <span className="mood">{r.mood}</span>}
                <span className="model">{r.model.split("/").pop()}</span>
              </div>
            ))}

            {(feed?.open_proposals.length ?? 0) > 0 && (
              <>
                <h2>On the floor</h2>
                {feed!.open_proposals.map((p) => (
                  <div className="prop" key={p.id}>
                    <div className="t">{p.title}</div>
                    <div className="m">{p.author} · {p.votes} vote{p.votes === 1 ? "" : "s"}</div>
                  </div>
                ))}
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
