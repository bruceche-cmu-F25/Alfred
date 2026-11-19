/** The presence window: Alfred's figure, always on screen in the Mac app.
 * It shows what Alfred is doing (working, something waiting) and greets the
 * user when they come back. Clicks pass through everything except the figure
 * and the bubble.
 */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AwayDigest, Notice } from "@alfred/protocol";
import { desktop } from "../desktop.ts";
import { createFigure, type Figure, type FigureState } from "../entity/tesseract.js";
import { setLocale, t, useLocale } from "../i18n/index.ts";
import { useAlfred } from "../useAlfred.ts";
import { welcomeLines } from "../welcome.ts";
import "./presence.css";

const WELCOME_MS = 15_000;
const BUSY = new Set(["queued", "running", "cancelling"]);

function Presence() {
  const { state } = useAlfred();
  // Speak the user's language, as set on the home node.
  useLocale();
  const locale = state?.settings?.locale;
  useEffect(() => { if (locale) setLocale(locale); }, [locale]);
  const [welcome, setWelcome] = useState<Notice | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const figure = useRef<Figure | null>(null);

  // The figure follows the system's light or dark appearance, like the bubble.
  useEffect(() => {
    if (!svg.current) return;
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const live = createFigure(svg.current, { width: 4.6, dark: dark.matches });
    figure.current = live;
    const follow = () => live.setDark(dark.matches);
    dark.addEventListener("change", follow);
    return () => { dark.removeEventListener("change", follow); live.destroy(); figure.current = null; };
  }, []);
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
  // Greeting when you come back, amber when something waits for you, the turning nut while it works.
  const mood: FigureState = welcome ? "hello" : waiting ? "notice" : working ? "work" : "rest";
  useEffect(() => { figure.current?.setState(mood); }, [mood]);

  const lines = welcome ? welcomeLines(welcome.payload as unknown as AwayDigest, desktop?.userName ?? null) : null;
  const label = working ? t("presence.working") : waiting ? t("presence.waiting") : "Alfred";
  const hover = { onMouseEnter: () => desktop?.setInteractive(true), onMouseLeave: () => desktop?.setInteractive(false) };

  return (
    <div className="presence">
      {lines && (
        <div className="bubble" role="status" {...hover}>
          <button type="button" className="bubble-body" onClick={() => close(true)}>
            <span className="greeting">{lines.greeting}</span>
            <span className="summary">{lines.summary}</span>
          </button>
          <button type="button" className="bubble-close" aria-label={t("presence.close")} onClick={() => close(false)}>×</button>
        </div>
      )}
      <button type="button" className="figure" aria-label={t("presence.open", { label })} title={label} onClick={() => desktop?.toggleMain()} {...hover}>
        <svg ref={svg} viewBox="0 0 120 120" aria-hidden="true" />
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Presence /></StrictMode>);
