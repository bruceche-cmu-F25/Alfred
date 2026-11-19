import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { AwayDigest, Notice } from "@alfred/protocol";
import { api, deviceId } from "./api.ts";
import { desktop } from "./desktop.ts";
import { AlfredPanel, figureState, statusLine } from "./shell/AlfredPanel.tsx";
import { Dock } from "./shell/Dock.tsx";
import { Figure } from "./shell/Figure.tsx";
import { Icon } from "./shell/icons.tsx";
import { ALF, dragHandle, NAV, PHONE, useLayout, useMedia, useViewportWidth, widths } from "./shell/layout.ts";
import { MOD, Nav } from "./shell/Nav.tsx";
import { availablePages, moduleOf, pageView } from "./shell/pages.tsx";
import { automationTitle } from "./automationText.ts";
import { Palette } from "./shell/Palette.tsx";
import { Pair } from "./Pair.tsx";
import { detectLocale, getLocale, setLocale, t, useLocale, type Locale } from "./i18n/index.ts";
import { useAlfred } from "./useAlfred.ts";
import { welcomeLines } from "./welcome.ts";

if (desktop) document.documentElement.classList.add("desktop");

/** True while the user is looking at this window: visible and focused. In the
 * Mac app the app says so; a page alone cannot tell a hidden window apart.
 */
function useAttention(): boolean {
  const read = () => document.visibilityState === "visible" && document.hasFocus();
  const [attending, setAttending] = useState(() => (desktop ? false : read()));
  useEffect(() => {
    if (desktop) return desktop.onAttention(setAttending);
    const update = () => setAttending(read());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return attending;
}

/** The open page and conversation live in the address (#p=todo.list&c=<id>), so a reload keeps both. */
function useRoute(): { page: string | null; selected: string | null; go(patch: { page?: string | null; selected?: string | null }): void } {
  const read = () => {
    const params = new URLSearchParams(location.hash.slice(1));
    return { page: params.get("p"), selected: params.get("c") };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const go = useCallback((patch: { page?: string | null; selected?: string | null }) => {
    setRoute((current) => {
      const next = { ...current, ...patch };
      const params = new URLSearchParams();
      if (next.page) params.set("p", next.page);
      if (next.selected) params.set("c", next.selected);
      const hash = params.toString();
      history.replaceState(null, "", hash ? `#${hash}` : location.pathname);
      return next;
    });
  }, []);
  return { ...route, go };
}

/** Notices are presented by one device only. This window claims a notice only
 * while the user is looking at it. What happens in the open conversation is
 * already on screen, so seeing it counts as being told; a result or a question
 * elsewhere becomes a small card that leads there. In the Mac app, the figure
 * greets; here only a plain browser does.
 */
function useNotices(notices: Notice[], selected: string | null, onPresented: (notice: Notice) => void): { shown: Notice[]; dismiss(notice: Notice, acknowledge?: boolean): void } {
  const [shown, setShown] = useState<Notice[]>([]);
  const handled = useRef(new Set<string>());
  const attending = useAttention();

  useEffect(() => {
    if (!attending) return;
    for (const notice of notices) {
      if (handled.current.has(notice.id)) continue;
      if (notice.kind === "welcome" && desktop) continue;
      const here = notice.payload.conversationId === selected;
      const show = () => {
        if ((notice.kind === "run_result" && here)) return api.acknowledge(notice.id).then(() => {});
        if (notice.kind === "run_request" && here) return; // answered inline; answering closes it
        setShown((current) => current.some((item) => item.id === notice.id) ? current : [...current, notice]);
      };
      if (notice.state === "presented") {
        // Shown here before (then a reload): show it again on this device only, never elsewhere.
        if (notice.claimedBy !== deviceId) continue;
        handled.current.add(notice.id);
        void show();
        continue;
      }
      handled.current.add(notice.id);
      api.claim(notice.id)
        .then(() => api.present(notice.id))
        .then(() => { onPresented(notice); return show(); })
        .catch(() => { /* another device has it */ });
    }
  }, [notices, attending, selected, onPresented]);

  // A card about the conversation now open has said what it had to say.
  useEffect(() => {
    setShown((current) => current.filter((notice) => notice.payload.conversationId !== selected || notice.kind === "run_interrupted"));
  }, [selected]);

  const dismiss = (notice: Notice, acknowledge = true) => {
    setShown((current) => current.filter((item) => item.id !== notice.id));
    if (acknowledge && notice.kind !== "run_request") api.acknowledge(notice.id).catch(() => {});
  };
  return { shown, dismiss };
}

function noticeText(notice: Notice): string {
  const goal = String(notice.payload.goal ?? "");
  if (notice.kind === "run_interrupted") return t("notice.interrupted", { goal });
  if (notice.kind === "run_request") return t("notice.request", { goal, question: String(notice.payload.question ?? "") });
  if (notice.kind === "run_result") return t("notice.result", { goal });
  if (notice.kind === "proposal") return t("notice.proposal", { title: String(notice.payload.title ?? "") });
  if (notice.kind === "welcome") {
    const { greeting, summary } = welcomeLines(notice.payload as unknown as AwayDigest, null);
    return `${greeting}${summary}`;
  }
  return goal || notice.kind;
}

/** The value once it has held still for `ms`: a state that lasts a moment (a reply ends a beat before its run
 * does) should not make the figure morph there and back. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** The workspace: sidebar, one page at a time, and Alfred beside it (or across it, or folded to a button). */
export function App() {
  const { state, connection, error, unpaired, fresh, live, onEvent } = useAlfred();
  const route = useRoute();
  const selected = route.selected;
  const [layout, setLayout] = useLayout();
  const phone = useMedia(PHONE);
  const viewport = useViewportWidth();
  const [sheet, setSheet] = useState<"alfred" | "nav" | null>(null);
  const [palette, setPalette] = useState(false);
  const [greeting, setGreeting] = useState(true);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(new Set());
  const [inboxFocus, setInboxFocus] = useState<string | null>(null);
  useLocale(); // re-render in the new language when it changes

  // The language is the user's, on the home node: follow it; if no device has set it yet, set it from this one's.
  const savedLocale = state?.settings?.locale;
  const askedLocale = useRef(false);
  useEffect(() => {
    if (!state) return;
    if (savedLocale) setLocale(savedLocale);
    else if (!askedLocale.current) { askedLocale.current = true; api.settings({ locale: detectLocale() }).catch(() => {}); }
  }, [state, savedLocale]);
  const switchLanguage = useCallback(() => {
    const next: Locale = getLocale() === "zh" ? "en" : "zh";
    setLocale(next);
    api.settings({ locale: next }).catch(() => {});
  }, []);
  const navStart = useRef(layout.navW);

  useEffect(() => { const timer = window.setTimeout(() => setGreeting(false), 2600); return () => window.clearTimeout(timer); }, []);

  const highlight = useCallback((runId: string) => {
    setHighlighted((current) => new Set(current).add(runId));
    window.setTimeout(() => setHighlighted((current) => { const next = new Set(current); next.delete(runId); return next; }), 2400);
  }, []);
  const onPresented = useCallback((notice: Notice) => {
    const runId = String(notice.payload.runId ?? "");
    if (runId) highlight(runId);
  }, [highlight]);
  const { shown, dismiss } = useNotices(state?.notices ?? [], selected, onPresented);

  /** Bring Alfred's panel up: beside the page on a desktop, as a sheet on a phone. */
  const showAlfred = useCallback(() => {
    if (phone) setSheet("alfred");
    else if (layout.alfred === "closed") setLayout({ alfred: "open" });
  }, [phone, layout.alfred, setLayout]);

  const select = useCallback((id: string | null) => {
    route.go({ selected: id });
    showAlfred();
  }, [route, showAlfred]);

  const showProposal = useCallback((proposalId: string) => {
    route.go({ page: "core.inbox" });
    setInboxFocus(`p:${proposalId}`);
    setSheet(null);
    if (layout.alfred === "wide") setLayout({ alfred: "open" });
  }, [route, layout.alfred, setLayout]);

  const openRun = useCallback((runId: string, conversationId?: string) => {
    // A run that left a proposal open: the decision is made in the inbox.
    const proposal = state?.proposals?.find((candidate) => candidate.runId === runId);
    if (proposal) { showProposal(proposal.id); return; }
    const go = (conversation: string) => {
      select(conversation);
      highlight(runId);
      window.setTimeout(() => document.getElementById(`run-${runId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
    };
    if (conversationId) go(conversationId);
    else api.run(runId).then(({ run }) => go(run.conversationId)).catch(() => {});
  }, [select, highlight, state?.proposals, showProposal]);

  const openConversation = useCallback((conversationId: string, runId?: string) => {
    select(conversationId);
    if (runId) {
      highlight(runId);
      window.setTimeout(() => document.getElementById(`run-${runId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
    }
  }, [select, highlight]);
  const onFocused = useCallback(() => setInboxFocus(null), []);

  const goPage = useCallback((key: string) => {
    route.go({ page: key });
    setSheet(null);
    if (layout.alfred === "wide") setLayout({ alfred: "open" });
  }, [route, layout.alfred, setLayout]);

  // A run opened a module's view: show that page.
  const onView = useCallback((module: string, view: string) => goPage(`${module}.${view}`), [goPage]);
  const onStarted = useCallback((id: string) => route.go({ selected: id }), [route]);

  const toggleAlfred = useCallback(() => {
    if (phone) setSheet((current) => current === "alfred" ? null : "alfred");
    else setLayout({ alfred: layout.alfred === "closed" ? "open" : "closed" });
  }, [phone, layout.alfred, setLayout]);
  const toggleNav = useCallback(() => setLayout({ nav: layout.nav === "full" ? "rail" : "full" }), [layout.nav, setLayout]);

  const pages = state ? availablePages(state) : [];
  const current = pages.find((page) => page.key === route.page) ?? pages[0];
  // The page a question is asked from, unless Alfred spans the window and the page is out of sight.
  const view = state && (phone || layout.alfred !== "wide") ? pageView(current, state) : undefined;
  const pageTitle = (key: string) => pages.find((page) => page.key === key)?.title;
  const automationOf = (id: string) => { const found = state?.automations?.find((automation) => automation.id === id); return found ? automationTitle(found) : undefined; };

  const ask = useCallback((text: string) => {
    showAlfred();
    api.submit(text, selected ?? undefined, view?.context).then(({ run }) => { if (!selected) route.go({ selected: run.conversationId }); }).catch(() => {});
  }, [showAlfred, selected, route, view?.context]);

  // The Mac app: a notification was clicked, or the hotkey brought the window up.
  useEffect(() => desktop?.onFocusRun((runId) => openRun(runId)), [openRun]);
  useEffect(() => desktop?.onFocusComposer(() => {
    showAlfred();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }), [showAlfred]);

  const figure = useSettled(state ? figureState(state, selected, live, greeting) : "rest", 250);

  // Keyboard: ⌘K anywhere; ⌘. Alfred; ⌘\ the sidebar; ⌥1–9 the pages (not while typing).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette((open) => !open); return; }
      if (mod && event.key === ".") { event.preventDefault(); toggleAlfred(); return; }
      if (mod && event.key === "\\") { event.preventDefault(); toggleNav(); return; }
      if (event.altKey && !mod && /^Digit[1-9]$/.test(event.code) && !editable(event.target)) {
        const page = pages[Number(event.code.slice(5)) - 1];
        if (page) { event.preventDefault(); goPage(page.key); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAlfred, toggleNav, goPage, pages]);

  // Another device that is not paired (or was revoked): pair first; a reload then starts with its token.
  if (unpaired) return <Pair onPaired={() => location.reload()} />;
  if (!state) {
    return (
      <main className="boot">
        <p className="wordmark">Alfred</p>
        <p className="quiet">{error ? t("boot.error", { error }) : t("boot.connecting")}</p>
      </main>
    );
  }

  const alfredMode = phone ? (sheet === "alfred" ? "open" : "closed") : layout.alfred;
  const size = widths(layout, viewport);

  // Sidebar divider: drag to resize; drag past the fold point to fold it to icons (keeping the width it had).
  const navDrag = dragHandle(layout.nav === "rail" ? NAV.rail : layout.navW, "right", (width) => {
    if (width < NAV.foldAt) setLayout({ nav: "rail", navW: navStart.current });
    else setLayout({ nav: "full", navW: Math.min(NAV.max, Math.max(NAV.min, width)) });
  });
  const alfDrag = dragHandle(size.alf, "left", (width) => setLayout({ alfW: Math.min(ALF.max, Math.max(ALF.min, width)) }));

  const panel = (
    <AlfredPanel state={state} selected={selected} figure={figure} wide={alfredMode === "wide"} phone={phone}
      live={live} highlighted={highlighted} view={view} pageTitle={pageTitle} automationTitle={automationOf} onEvent={onEvent} onView={onView} onStarted={onStarted}
      onWide={() => setLayout({ alfred: layout.alfred === "wide" ? "open" : "wide" })}
      onClose={() => (phone ? setSheet(null) : setLayout({ alfred: "closed" }))} />
  );

  return (
    <div className="workspace" data-nav={phone ? undefined : layout.nav} data-alfred={alfredMode} data-phone={phone || undefined}
      data-sheet={sheet ?? undefined} style={{ "--nav-px": `${size.nav}px`, "--alf-px": `${size.alf}px` } as CSSProperties}>
      {(!phone || sheet === "nav") && (
        <Nav state={state} pages={pages} page={current?.key ?? ""} mode={phone ? "full" : layout.nav} selected={selected} connection={connection}
          onPage={goPage} onSelect={(id) => { setSheet(null); select(id); }} onFold={phone ? () => setSheet(null) : toggleNav}
          onPalette={() => { setSheet(null); setPalette(true); }} onConversations={showAlfred} sheet={phone} onLanguage={switchLanguage} />
      )}
      {phone && sheet === "nav" && <div className="scrim" onClick={() => setSheet(null)} />}

      <main className="page" data-k={current?.k}>
        {current ? (
          <>
            <header className="page-head">
              <h1><Icon name={current.icon} />{current.title}</h1>
              {current.summary && <p className="page-sub">{current.summary(state.modules[moduleOf(current)], state)}</p>}
            </header>
            <div className="page-body">{current.render({
              snapshot: state.modules[moduleOf(current)], fresh, areas: state.areas ?? [], state, focus: inboxFocus, onFocused, openConversation,
            })}</div>
          </>
        ) : (
          <div className="empty"><p className="empty-title">{t("page.none")}</p><p className="quiet">{t("page.noneHint")}</p></div>
        )}
      </main>

      {alfredMode !== "closed" && panel}

      {!phone && (
        <>
          <div className="resizer resizer-nav" onPointerDown={(event) => { navStart.current = layout.navW; navDrag(event); }}
            onDoubleClick={toggleNav} title={t("resize.nav")} />
          {alfredMode === "open" && (
            <div className="resizer resizer-alf" onPointerDown={alfDrag} onDoubleClick={() => setLayout({ alfW: ALF.def })} title={t("resize.alf")} />
          )}
        </>
      )}

      {!phone && alfredMode === "closed" && (
        <button type="button" className="fab" onClick={showAlfred} title={t("fab.open", { key: `${MOD}.` })}>
          <Figure state={figure} size={30} /><span>{statusLine(state, selected, view?.headline)}</span>
        </button>
      )}
      {phone && sheet !== "alfred" && (
        <Dock state={state} pages={pages} page={current?.key ?? ""} figure={figure} onPage={goPage}
          onAlfred={() => setSheet("alfred")} onConversations={() => setSheet("nav")} />
      )}

      {palette && (
        <Palette pages={pages} conversations={state.conversations} onPage={goPage} onSelect={select} onAsk={ask} onClose={() => setPalette(false)}
          actions={[
            { id: "new", label: t("cmd.new"), icon: "plus", run: () => select(null) },
            { id: "alfred", label: t(alfredMode === "closed" ? "cmd.openAlfred" : "cmd.closeAlfred"), icon: "panel", hint: `${MOD}.`, run: toggleAlfred },
            ...(phone ? [] : [{ id: "nav", label: t(layout.nav === "full" ? "cmd.foldNav" : "cmd.unfoldNav"), icon: "rail" as const, hint: `${MOD}\\`, run: toggleNav }]),
            { id: "language", label: t("cmd.language"), icon: "chat", run: switchLanguage },
          ]} />
      )}

      {shown.length > 0 && (
        <aside className="notices" aria-live="polite">
          {shown.map((notice) => (
            <div className="notice" key={notice.id} role="status">
              <p>{noticeText(notice)}</p>
              <div className="notice-actions">
                {notice.kind === "run_interrupted" && (
                  <button type="button" onClick={() => { api.resume(String(notice.payload.runId)).catch(() => {}); dismiss(notice); }}>{t("common.continue")}</button>
                )}
                {notice.kind === "proposal" && (
                  <button type="button" onClick={() => { showProposal(String(notice.payload.proposalId)); dismiss(notice); }}>{t("notice.look")}</button>
                )}
                {(notice.kind === "run_result" || notice.kind === "run_request") && notice.payload.runId ? (
                  <button type="button" onClick={() => { openRun(String(notice.payload.runId), String(notice.payload.conversationId ?? "") || undefined); dismiss(notice); }}>
                    {t(notice.kind === "run_request" ? "notice.answer" : "notice.view")}
                  </button>
                ) : null}
                <button type="button" className="ghost" onClick={() => dismiss(notice)}>{t("common.gotIt")}</button>
              </div>
            </div>
          ))}
        </aside>
      )}
    </div>
  );
}
