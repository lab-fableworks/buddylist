/**
 * Tiny window manager: draggable, resizable, focusable, minimizable windows + taskbar.
 *
 * Resizing works the way a desktop window does: any edge or corner, with the opposite edge
 * pinned. A window has no explicit size until someone resizes it - until then the CSS class
 * decides - so the defaults stay in one place. Sizes are remembered per window id, so a chat
 * window you made taller is taller next time.
 */
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
  /** Explicit size, present only once the user has resized (or restored a remembered size). */
  w?: number;
  h?: number;
  /** Geometry to go back to after maximize. */
  restore?: { x: number; y: number; w?: number; h?: number };
}

const MIN_W = 220; // matches .win min-width in retro.css
const MIN_H = 120;
const TASKBAR = 28;

const sizeKey = (id: string) => "bl.win." + id;
const remembered = (id: string): { w: number; h: number } | undefined => {
  try {
    const s = localStorage.getItem(sizeKey(id));
    return s ? (JSON.parse(s) as { w: number; h: number }) : undefined;
  } catch {
    return undefined;
  }
};
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
      return { ...w, [spec.id]: { ...spec, ...remembered(spec.id), x: spec.x ?? 280 + cascade * 24, y: spec.y ?? 40 + cascade * 24, z: ++zTop, minimized: false } };
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
  const resize = (id: string, g: { x: number; y: number; w: number; h: number }) => {
    setWins((w) => ({ ...w, [id]: { ...w[id], ...g } }));
    try {
      localStorage.setItem(sizeKey(id), JSON.stringify({ w: g.w, h: g.h }));
    } catch {
      /* private mode; size just is not remembered */
    }
  };
  const toggleMax = (id: string) =>
    setWins((w) => {
      const win = w[id];
      if (!win) return w;
      if (win.restore) return { ...w, [id]: { ...win, ...win.restore, restore: undefined } };
      return { ...w, [id]: { ...win, restore: { x: win.x, y: win.y, w: win.w, h: win.h }, x: 0, y: 0, w: window.innerWidth, h: window.innerHeight - TASKBAR } };
    });
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
        <Window
          key={w.id}
          w={w}
          active={active === w.id}
          onFocus={() => focus(w.id)}
          onClose={() => close(w.id)}
          onMin={() => minimize(w.id)}
          onMove={(x, y) => move(w.id, x, y)}
          onResize={(g) => resize(w.id, g)}
          onMax={() => toggleMax(w.id)}
        />
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

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function Window({
  w,
  active,
  onFocus,
  onClose,
  onMin,
  onMove,
  onResize,
  onMax,
}: {
  w: WinState;
  active: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMin: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (g: { x: number; y: number; w: number; h: number }) => void;
  onMax: () => void;
}) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  /** Pointer position and window rect when a resize began; the edge says which sides move. */
  const rs = useRef<{ edge: Edge; px: number; py: number; x: number; y: number; w: number; h: number } | null>(null);

  const onResizeDown = (edge: Edge) => (e: React.PointerEvent) => {
    const r = el.current?.getBoundingClientRect();
    if (!r) return;
    e.stopPropagation();
    onFocus();
    rs.current = { edge, px: e.clientX, py: e.clientY, x: w.x, y: w.y, w: r.width, h: r.height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const s = rs.current;
    if (!s) return;
    const dx = e.clientX - s.px;
    const dy = e.clientY - s.py;
    let { x, y, w: width, h: height } = s;
    // Each edge moves independently; the opposite edge stays where it was.
    if (s.edge.includes("e")) width = Math.max(MIN_W, s.w + dx);
    if (s.edge.includes("s")) height = Math.max(MIN_H, s.h + dy);
    if (s.edge.includes("w")) {
      width = Math.max(MIN_W, s.w - dx);
      x = s.x + (s.w - width);
    }
    if (s.edge.includes("n")) {
      height = Math.max(MIN_H, s.h - dy);
      y = Math.max(0, s.y + (s.h - height));
      if (y === 0) height = s.y + s.h; // hit the top: grow only as far as the screen allows
    }
    onResize({ x, y, w: width, h: height });
  };
  const onResizeUp = () => (rs.current = null);
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
  const maximize = () => onMax();
  if (w.minimized) return null;
  const size = w.w !== undefined && w.h !== undefined ? { width: w.w, height: w.h } : {};
  return (
    <div
      ref={el}
      className={"win " + (w.className ?? "") + (active ? " active" : "") + (w.restore ? " maxed" : "")}
      style={{ left: w.x, top: w.y, zIndex: w.z, ...size }}
      onPointerDown={onFocus}
      role="dialog"
      aria-label={w.title}
    >
      <div className="titlebar" onPointerDown={onDown} onPointerMove={onMoveP} onPointerUp={onUp} onDoubleClick={maximize}>
        <span className="ico">{w.icon ?? "▫"}</span>
        <span className="title">{w.title}</span>
        <button className="tbtn" onClick={onMin} aria-label="Minimize">_</button>
        <button className="tbtn" onClick={maximize} aria-label={w.restore ? "Restore" : "Maximize"}>{w.restore ? "❐" : "□"}</button>
        <button className="tbtn" onClick={onClose} aria-label="Close">×</button>
      </div>
      {w.render({ close: onClose })}
      {!w.restore && EDGES.map((edge) => <div key={edge} className={"rs rs-" + edge} onPointerDown={onResizeDown(edge)} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />)}
    </div>
  );
}
