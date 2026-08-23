import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Stream } from "./Stream";
import "./stream.css";

/**
 * A blank overlay is a bug report with the evidence removed. Anything that would kill the
 * page - a render crash, an unhandled rejection, a global error - is caught and printed on
 * the desktop itself, in period style, so the screen tells us what happened instead of
 * silently showing wallpaper. This exists because a viewer reported exactly that blank.
 */
class Boundary extends Component<{ children: ReactNode }, { err?: string }> {
  state: { err?: string } = {};
  static getDerivedStateFromError(e: unknown) {
    return { err: String((e as Error)?.message ?? e) };
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="crash win active">
        <div className="titlebar"><span className="ico">!</span><span className="title">BuddyList - error</span></div>
        <div className="crashbody">
          <p>The overlay hit an error and stopped. This text is the bug report:</p>
          <pre>{this.state.err}</pre>
          <p>It will retry in 15 seconds.</p>
        </div>
      </div>
    );
  }
  componentDidCatch() {
    setTimeout(() => window.location.reload(), 15_000);
  }
}

// Errors outside React (fetch handlers, intervals) get the same treatment: visible.
const strip = (msg: string) => {
  const el = document.createElement("div");
  el.className = "errstrip";
  el.textContent = "overlay error: " + msg.slice(0, 300);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 30_000);
};
window.addEventListener("error", (e) => strip(e.message));
window.addEventListener("unhandledrejection", (e) => strip(String((e.reason as Error)?.message ?? e.reason)));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <Stream />
    </Boundary>
  </StrictMode>,
);
