import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { t } from "./i18n/index.ts";
import { Figure } from "./shell/Figure.tsx";

export interface NamePreference { name: string | null; saveName(name: string): Promise<void> }

const GREETING_MS = 5000;
type Scene = "ask" | "greet" | "clear";

export function InboxEntry({ name, saveName, hasItems, onEnter }: NamePreference & { hasItems: boolean; onEnter?: () => void }) {
  const [firstMeeting] = useState(() => !name);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [scene, setScene] = useState<Scene>(() => !onEnter ? "clear" : name ? "greet" : "ask");
  const group = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLDivElement>(null);

  // Keep the same figure for the question, greeting and All clear. Only the list takes its place.
  const next = !onEnter ? "clear" : !name ? "ask" : !leaving ? "greet" : hasItems ? "list" : "clear";
  const finish = useEffectEvent(() => {
    if (next !== "list") setScene(next);
    if (next === "clear" || next === "list") onEnter?.();
    setLeaving(false);
  });
  useLayoutEffect(() => {
    if (scene === next) return;
    const element = next === "list" ? group.current : words.current;
    if (!element || matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
    const fade = element.animate(
      [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-5px)" }],
      { duration: 320, easing: "ease-in", fill: "forwards" },
    );
    fade.finished.then(() => finish(), () => { /* The user left or a new scene took its place. */ });
    return () => fade.cancel();
  }, [scene, next]);

  useEffect(() => {
    if (scene !== "greet" || leaving) return;
    let timer: number | undefined;
    const startWhenVisible = () => {
      window.clearTimeout(timer);
      if (!document.hidden) timer = window.setTimeout(() => setLeaving(true), GREETING_MS);
    };
    startWhenVisible();
    document.addEventListener("visibilitychange", startWhenVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", startWhenVisible);
    };
  }, [scene, leaving]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || name || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await saveName(draft.trim());
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="empty inbox-entry">
      <div className="inbox-entry-center" ref={group}>
        <Figure state="rest" size={112} className="figure-tour" />
        <div className="inbox-entry-body" key={scene} ref={words}>
          {scene === "ask" && (
            <>
              <h2 className="empty-title"><label htmlFor="preferred-name">{t("inbox.askName")}</label></h2>
              <form className="inbox-name-form" onSubmit={submit} aria-busy={busy}>
                <input id="preferred-name" name="nickname" autoComplete="nickname" maxLength={80} required placeholder={t("inbox.name")}
                  value={draft} onChange={(event) => setDraft(event.target.value)} readOnly={busy || !!name} />
                <button type="submit" disabled={busy || !!name || !draft.trim()}>{t("common.continue")}</button>
              </form>
              {error && <p className="problem small" role="alert">{error}</p>}
            </>
          )}
          {scene === "greet" && (
            <>
              <p className="empty-title" role="status">{t(firstMeeting ? "inbox.meetName" : "inbox.backName", { name: name ?? "" })}</p>
              <button type="button" className="inbox-enter" onClick={() => setLeaving(true)}>{t("inbox.enter")} <span aria-hidden="true">→</span></button>
            </>
          )}
          {scene === "clear" && (
            <>
              <p className="empty-title" role="status">{t("inbox.emptyTitle")}</p>
              <p className="quiet">{t("inbox.emptyHint")}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
