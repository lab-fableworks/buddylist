/** Tiny window manager: draggable, focusable, minimizable windows + taskbar. */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export interface WinSpec {
  id: string;
  title: string;
  icon?: string;
  className?: string;
  x?: number;
  y?: number;
  render: (api: { close: () => void }) => React.ReactNode;
}
interface WinState extends WinSpec {
  z: number;
  minimized: boolean;
  x: number;
  y: number;
}
interface WM {
  open(spec: WinSpec): void;
  close(id: string): void;
  focus(id: string): void;
  has(id: string): boolean;
}
const Ctx = createContext<WM>(null!);
export const useWM = () => useContext(Ctx);

let zTop = 10;
let cascade = 0;

export function WindowManager({ children, fixed }: { children?: React.ReactNode; fixed?: React.ReactNode }) {
  const [wins, setWins] = useState<Record<string, WinState>>({});
  const [active, setActive] = useState<string>();

  const open = useCallback((spec: WinSpec) => {
    setWins((w) => {
      if (w[spec.id]) return { ...w, [spec.id]: { ...w[spec.id], minimized: false, z: ++zTop, title: spec.title, render: spec.render } };
      cascade = (cascade + 1) % 8;
      return { ...w, [spec.id]: { ...spec, x: spec.x ?? 280 + cascade * 24, y: spec.y ?? 40 + cascade * 24, z: ++zTop, minimized: false } };
    });
    setActive(spec.id);
  }, []);
  const close = useCallback((id: string) => {
    setWins((w) => {
      const n = { ...w };
      delete n[id];
      return n;
    });
    setActive((a) => (a === id ? undefined : a));
  }, []);
  const focus = useCallback((id: string) => {
    setWins((w) => (w[id] ? { ...w, [id]: { ...w[id], z: ++zTop, minimized: false } } : w));
    setActive(id);
  }, []);
  const minimize = (id: string) => {
    setWins((w) => ({ ...w, [id]: { ...w[id], minimized: true } }));
    setActive((a) => (a === id ? undefined : a));
  };
  const move = (id: string, x: number, y: number) => setWins((w) => ({ ...w, [id]: { ...w[id], x, y } }));
  const api = useMemo<WM>(() => ({ open, close, focus, has: (id) => id in wins }), [open, close, focus, wins]);

  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Ctx.Provider value={api}>
      {fixed}
      {Object.values(wins).map((w) => (
        <Window key={w.id} w={w} active={active === w.id} onFocus={() => focus(w.id)} onClose={() => close(w.id)} onMin={() => minimize(w.id)} onMove={(x, y) => move(w.id, x, y)} />
      ))}
      {children}
      <div className="taskbar">
        <button className="btn start">🟡 BuddyList</button>
        {Object.values(wins)
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((w) => (
            <button key={w.id} className={"btn task" + (active === w.id ? " down" : "")} onClick={() => (active === w.id ? minimize(w.id) : focus(w.id))}>
              {w.icon ?? "▫"} {w.title}
            </button>
          ))}
        <span className="clock cell">{clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
      </div>
    </Ctx.Provider>
  );
}

function Window({ w, active, onFocus, onClose, onMin, onMove }: { w: WinState; active: boolean; onFocus: () => void; onClose: () => void; onMin: () => void; onMove: (x: number, y: number) => void }) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { dx: e.clientX - w.x, dy: e.clientY - w.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMoveP = (e: React.PointerEvent) => {
    if (!drag.current) return;
    onMove(Math.max(0, e.clientX - drag.current.dx), Math.max(0, e.clientY - drag.current.dy));
  };
  const onUp = () => (drag.current = null);
  if (w.minimized) return null;
  return (
    <div className={"win " + (w.className ?? "") + (active ? " active" : "")} style={{ left: w.x, top: w.y, zIndex: w.z }} onPointerDown={onFocus} role="dialog" aria-label={w.title}>
      <div className="titlebar" onPointerDown={onDown} onPointerMove={onMoveP} onPointerUp={onUp} onDoubleClick={onMin}>
        <span className="ico">{w.icon ?? "▫"}</span>
        <span className="title">{w.title}</span>
        <button className="tbtn" onClick={onMin} aria-label="Minimize">_</button>
        <button className="tbtn" onClick={onClose} aria-label="Close">×</button>
      </div>
      {w.render({ close: onClose })}
    </div>
  );
}
