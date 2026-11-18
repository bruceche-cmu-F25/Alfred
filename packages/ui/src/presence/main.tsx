/** The presence window: Alfred's figure, always on screen in the Mac app.
 * It shows what Alfred is doing (working, something waiting) and greets the
 * user when they come back. Clicks pass through everything except the figure
 * and the bubble.
 */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AwayDigest, Notice } from "@alfred/protocol";
import { desktop } from "../desktop.ts";
import { createSky, type SkyState } from "../entity/sky.js";
import { useAlfred } from "../useAlfred.ts";
import { welcomeLines } from "../welcome.ts";
import "./presence.css";

const WELCOME_MS = 15_000;
const BUSY = new Set(["queued", "running", "cancelling"]);

function Presence() {
  const { state } = useAlfred();
  const [welcome, setWelcome] = useState<Notice | null>(null);
  const sky = useRef<ReturnType<typeof createSky> | null>(null);

  useEffect(() => { sky.current = createSky(); }, []);
  useEffect(() => desktop?.onWelcome((notice) => setWelcome(notice)), []);

  const close = (opened: boolean) => {
    if (!welcome) return;
    desktop?.welcomeDone(welcome.id, opened);
    if (opened) desktop?.openMain();
    setWelcome(null);
    desktop?.setInteractive(false);
  };

  // One timer per welcome; live updates must not keep restarting it.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!welcome) return;
    const timer = window.setTimeout(() => closeRef.current(false), WELCOME_MS);
    return () => window.clearTimeout(timer);
  }, [welcome]);

  const working = state?.runs.some((run) => BUSY.has(run.state)) ?? false;
  const waiting = state?.notices.some((notice) => notice.kind !== "welcome") ?? false;
  const mood: SkyState = welcome || waiting ? "notice" : working ? "working" : "idle";
  useEffect(() => { sky.current?.setState(mood); }, [mood]);

  const lines = welcome ? welcomeLines(welcome.payload as unknown as AwayDigest, desktop?.userName ?? null) : null;
  const label = working ? "Alfred 正在办事" : waiting ? "Alfred 有事等你看" : "Alfred";
  const hover = { onMouseEnter: () => desktop?.setInteractive(true), onMouseLeave: () => desktop?.setInteractive(false) };

  return (
    <div className="presence">
      {lines && (
        <div className="bubble" role="status" {...hover}>
          <button type="button" className="bubble-body" onClick={() => close(true)}>
            <span className="greeting">{lines.greeting}</span>
            <span className="summary">{lines.summary}</span>
          </button>
          <button type="button" className="bubble-close" aria-label="关掉" onClick={() => close(false)}>×</button>
        </div>
      )}
      <button type="button" className="figure" aria-label={`${label}。点按打开主窗口`} title={label} onClick={() => desktop?.toggleMain()} {...hover}>
        <canvas data-sky aria-hidden="true" />
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Presence /></StrictMode>);
