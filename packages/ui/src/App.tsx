import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AwayDigest, Notice } from "@alfred/protocol";
import { ApiError, api, deviceId } from "./api.ts";
import { desktop } from "./desktop.ts";
import { AlfredPanel, figureState } from "./shell/AlfredPanel.tsx";
import type { About, Picked } from "./shell/about.ts";
import { continues } from "./shell/ask.ts";
import { AskBar } from "./shell/AskBar.tsx";
import type { FindCommand, FindSources } from "./shell/find.ts";
import { Dock } from "./shell/Dock.tsx";
import { Says } from "./shell/Says.tsx";
import type { FigureState } from "./entity/tesseract.js";
import { noticeLines } from "./noticeText.ts";
import type { Outcome, Said } from "./speech/useSpeech.ts";
import { Icon } from "./shell/icons.tsx";
import { ALF, dragHandle, NAV, PHONE, useLayout, useMedia, useViewportWidth, widths } from "./shell/layout.ts";
import { MOD, Nav } from "./shell/Nav.tsx";
import { Topbar, type Mode } from "./shell/Topbar.tsx";
import { availablePages, moduleOf, pageView } from "./shell/pages.tsx";
import { automationTitle } from "./automationText.ts";
import { Palette } from "./shell/Palette.tsx";
import { Pair } from "./Pair.tsx";
import { detectLocale, getLocale, setLocale, t, useLocale, type Locale } from "./i18n/index.ts";
import { getScheme, setAppearance } from "./scheme.ts";
import { useAlfred } from "./useAlfred.ts";
import { handed } from "./handed.ts";
import { useOutlet } from "./outlet.ts";
import { welcomeLines } from "./welcome.ts";

if (desktop) document.documentElement.classList.add("desktop");
desktop?.onFullScreen?.((full) => document.documentElement.classList.toggle("full-screen", full));
// An iPhone or iPad zooms the page in when a field whose text is under 16px takes focus, and leaves it zoomed: the
// page is then wider than the screen. A top scale of 1 stops that there, and pinching still zooms. (Only there:
// on Android the same line would take pinching away.)
if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover");
}

const DEV_PAGE = "core.dev";

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

/** The open page, conversation and development session live in the address (#p=todo.list&c=<id>&s=<id>), so a reload keeps them. */
type Route = { page: string | null; selected: string | null; session: string | null };
function useRoute(): Route & { go(patch: Partial<Route>): void } {
  const read = (): Route => {
    const params = new URLSearchParams(location.hash.slice(1));
    return { page: params.get("p"), selected: params.get("c"), session: params.get("s") };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const go = useCallback((patch: Partial<Route>) => {
    setRoute((current) => {
      const next = { ...current, ...patch };
      const params = new URLSearchParams();
      if (next.page) params.set("p", next.page);
      if (next.selected) params.set("c", next.selected);
      if (next.session) params.set("s", next.session);
      const hash = params.toString();
      history.replaceState(null, "", hash ? `#${hash}` : location.pathname);
      return next;
    });
  }, []);
  return { ...route, go };
}

/** A notice is shown in one place only, and the home node says where (docs/design/attention.md): this window shows
 * what was handed to it, while the user is looking at it. What happens in the open conversation is already on
 * screen, so seeing it counts as being told; a result or a question elsewhere is said by Alfred (shell/Says.tsx),
 * leading there.
 */
function useNotices(notices: Notice[], selected: string | null, onPresented: (notice: Notice) => void, inCard: { current: boolean }): { shown: Notice[]; remove(notice: Notice): void; acknowledge(notice: Notice): void } {
  const [shown, setShown] = useState<Notice[]>([]);
  const handled = useRef(new Set<string>());
  const attending = useAttention();
  useOutlet(attending);

  useEffect(() => {
    if (!attending) return;
    for (const notice of notices) {
      if (handled.current.has(notice.id)) continue;
      const mine = handed(notice, deviceId);
      if (!mine) continue;
      const here = notice.payload.conversationId === selected;
      const show = () => {
        if ((notice.kind === "run_result" && here)) return api.acknowledge(notice.id).then(() => {});
        if (notice.kind === "run_request" && here) return; // answered inline; answering closes it
        // The ask bar's card already shows it with its buttons; said again above it, it would be said twice. It waits in 通知.
        if (notice.kind === "proposal" && here && inCard.current) return;
        setShown((current) => current.some((item) => item.id === notice.id) ? current : [...current, notice]);
      };
      handled.current.add(notice.id);
      if (mine === "again") { void show(); continue; }
      api.present(notice.id)
        .then(() => { onPresented(notice); return show(); })
        // It is no longer this window's to show. If it is handed here again, it is shown then.
        .catch(() => { handled.current.delete(notice.id); });
    }
  }, [notices, attending, selected, onPresented]);

  // A card about the conversation now open has said what it had to say.
  useEffect(() => {
    setShown((current) => current.filter((notice) => notice.payload.conversationId !== selected || notice.kind === "run_interrupted"));
  }, [selected]);

  const remove = useCallback((notice: Notice) => setShown((current) => current.filter((item) => item.id !== notice.id)), []);
  // A question is closed by answering it.
  const acknowledge = useCallback((notice: Notice) => { if (notice.kind !== "run_request") api.acknowledge(notice.id).catch(() => {}); }, []);
  return { shown, remove, acknowledge };
}

/** How long Alfred's card about a notice stays once said (never while the pointer is on it); it stays in 通知 after. */
const STAY_MS: Record<string, number> = { welcome: 15_000, run_result: 12_000, run_interrupted: 20_000 };

/** What Alfred says in the app about a notice; the button is what can be done here. */
function noticeSaid(notice: Notice): Said {
  if (notice.kind === "welcome") {
    const { greeting, summary } = welcomeLines(notice.payload as unknown as AwayDigest, null);
    return { title: greeting, body: summary, mood: "hello", action: t("common.gotIt") };
  }
  const { title, body, mood } = noticeLines(notice);
  const action = notice.kind === "run_interrupted" ? t("common.continue") : notice.kind === "proposal" ? t("notice.look")
    : notice.kind === "run_request" ? t("notice.answer") : t("notice.view");
  return { title, body, mood, action };
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
  /** A phone: the dock's tabs have given way to the ask bar. */
  const [asking, setAsking] = useState(false);
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
  /** The ask bar is on screen: its card shows what the open conversation's newest turn left, proposals included. */
  const inCard = useRef(false);
  const { shown, remove: unshow, acknowledge } = useNotices(state?.notices ?? [], selected, onPresented, inCard);
  /** Alfred's look while it is telling the user something. */
  const [speaking, setSpeaking] = useState<FigureState | null>(null);

  /** Bring Alfred's panel up: beside the page on a desktop, as a sheet on a phone. */
  const showAlfred = useCallback(() => {
    if (phone) setSheet("alfred");
    else if (layout.alfred === "closed") setLayout({ alfred: "open" });
  }, [phone, layout.alfred, setLayout]);

  /** Opens a development session on the Code page. */
  const openSession = useCallback((id: string | null) => {
    route.go({ page: DEV_PAGE, session: id });
    setSheet(null);
  }, [route]);

  const select = useCallback((id: string | null) => {
    // A development session opens on the Code page, not in Alfred's panel.
    if (id && state?.conversations.find((conversation) => conversation.id === id)?.projectId) { openSession(id); return; }
    route.go({ selected: id });
    showAlfred();
  }, [route, showAlfred, state?.conversations, openSession]);

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

  const pages = state ? availablePages(state) : [];
  const current = pages.find((page) => page.key === route.page) ?? pages[0];
  // A bare page (Code) takes the room Alfred's panel would; on a phone the panel is a sheet anyway.
  const bare = !!current?.bare;
  const alfredMode = phone ? (sheet === "alfred" ? "open" : "closed") : bare ? "closed" : layout.alfred;
  const size = widths(layout, viewport, alfredMode === "open");
  /** The sidebar as drawn: folded away when the window has no room for it beside Alfred. */
  const navMode = size.navMode;
  const toggleNav = useCallback(() => {
    // Folded for want of room: showing it puts Alfred away, which is what makes the room.
    if (layout.nav === "full" && navMode === "hidden") setLayout({ alfred: "closed" });
    else setLayout({ nav: layout.nav === "full" ? "hidden" : "full" });
  }, [layout.nav, navMode, setLayout]);
  // Daily or Code: follows the page; Settings belongs to both, so it keeps the one it was opened from.
  // Each side remembers its last page, so switching back lands where the user was.
  const pageMode: Mode | null = current?.group === "dev" ? "dev" : current?.group === "system" ? null : current ? "daily" : null;
  const lastMode = useRef<Mode>("daily");
  const lastPage = useRef<Record<Mode, string>>({ daily: "", dev: "" });
  if (pageMode && current) { lastMode.current = pageMode; lastPage.current[pageMode] = current.key; }
  const mode = pageMode ?? lastMode.current;
  const hasDev = pages.some((page) => page.group === "dev");
  const switchMode = (next: Mode) => {
    const first = pages.find((page) => (next === "dev" ? page.group === "dev" : page.group === "work" || page.group === "modules"));
    const key = lastPage.current[next] || first?.key;
    if (key) goPage(key);
  };
  // The page a question is asked from, unless Alfred spans the window and the page is out of sight.
  const view = state && (phone || layout.alfred !== "wide") ? pageView(current, state) : undefined;
  const pageTitle = (key: string) => pages.find((page) => page.key === key)?.title;
  const automationOf = (id: string) => { const found = state?.automations?.find((automation) => automation.id === id); return found ? automationTitle(found) : undefined; };

  /** Says something to Alfred from outside its panel (the ask bar, the palette). It joins the open conversation
   * while that is recent, going straight into a turn that is still running; otherwise it starts a new one. */
  const conversations = state?.conversations, runs = state?.runs, go = route.go;
  const ask = useCallback(async (text: string) => {
    const target = continues(conversations?.find((conversation) => conversation.id === selected), Date.now());
    const submit = () => api.submit(text, target ?? undefined, view?.context).then(({ run }) => { if (run.conversationId !== selected) go({ selected: run.conversationId }); });
    const working = target ? runs?.find((run) => run.conversationId === target && run.state === "running") : undefined;
    if (!working) return submit();
    // It may have just finished: then it goes as a new message.
    await api.steer(working.id, text).then(() => undefined, (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 409) return submit();
      throw reason;
    });
  }, [conversations, runs, selected, go, view?.context]);
  /** What the user picked on the page to say something about: the bar's next words go to it (shell/about.ts). */
  const [about, setAbout] = useState<About | null>(null);
  const pageKey = current?.key;
  useEffect(() => setAbout(null), [pageKey]);
  const attach = useCallback((next: About | null) => {
    setAbout(next);
    if (!next) return;
    // The bar is where the words are written: it comes up if Alfred's panel or the phone's tabs are in its place.
    if (phone) { setSheet(null); setAsking(true); }
    else if (layout.alfred !== "closed") setLayout({ alfred: "closed" });
  }, [phone, layout.alfred, setLayout]);
  // The same page and facts are the same context, whichever render they came from.
  const contextKey = view ? JSON.stringify(view.context) : "";
  const context = useMemo(() => (contextKey ? JSON.parse(contextKey) as NonNullable<typeof view>["context"] : undefined), [contextKey]);
  /** A question about one thing on the page. It joins the open conversation only while that is recent and at rest. */
  const askPicked = useCallback(async (goal: string, picked: Picked) => {
    const open = conversations?.find((conversation) => conversation.id === selected);
    const target = open && !open.busy && !open.attention ? continues(open, Date.now()) : null;
    const { run } = await api.submit(goal, target ?? undefined, context ? { ...context, selection: picked } : undefined);
    if (run.conversationId !== selected) go({ selected: run.conversationId });
    return run.id;
  }, [conversations, selected, go, context]);
  const revisePicked = useCallback(async (proposalId: string, text: string, picked: Picked) => {
    const { run } = await api.revise(proposalId, text, context ? { ...context, selection: picked } : undefined);
    if (run && run.conversationId !== selected) go({ selected: run.conversationId });
    return run?.id ?? null;
  }, [selected, go, context]);
  const line = useMemo(() => ({ about: about?.key ?? null, attach, ask: askPicked, revise: revisePicked }), [about?.key, attach, askPicked, revisePicked]);
  /** The ask bar is where Alfred is talked to: its panel is closed and the page leaves it room. */
  const barHere = !phone && !bare && alfredMode === "closed";
  inCard.current = barHere || (phone && asking && !bare);
  /** From the palette: the answer comes out of the ask bar when it is there, else in the panel. */
  const askAnywhere = useCallback((text: string) => {
    if (phone && !bare) setAsking(true);
    else if (!barHere) showAlfred();
    ask(text).catch(() => {});
  }, [ask, phone, bare, barHere, showAlfred]);

  // The Mac app: a notification was clicked, or the hotkey brought the window up.
  useEffect(() => desktop?.onFocusRun((runId) => openRun(runId)), [openRun]);
  useEffect(() => desktop?.onFocusComposer(() => {
    // The ask bar when it is there: talking does not need the panel.
    const bar = document.querySelector<HTMLInputElement>(".ask-form input");
    if (bar) { bar.focus(); return; }
    showAlfred();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }), [showAlfred]);

  const settledFigure = useSettled(state ? figureState(state, selected, live, greeting) : "rest", 250);
  const figure = speaking ?? settledFigure;

  // Keyboard: ⌘K search and ask, anywhere; ⌘. Alfred; ⌘\ the sidebar; ⌥1–9 the pages (not while typing).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // Searching is done in the ask bar where it is on screen; the palette is for where it is not.
        const bar = document.querySelector<HTMLInputElement>(".ask-form input");
        if (!bar) setPalette((open) => !open);
        else if (document.activeElement === bar) bar.blur();
        else { bar.focus(); bar.select(); }
        return;
      }
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

  // Sidebar divider: drag to resize; drag past the fold point to fold it to icons (keeping the width it had).
  const navDrag = dragHandle(size.nav, "right", (width) => {
    if (width < NAV.foldAt) setLayout({ nav: "hidden", navW: navStart.current });
    else setLayout({ nav: "full", navW: Math.min(NAV.max, Math.max(NAV.min, width)) });
  });
  const alfDrag = dragHandle(size.alf, "left", (width) => setLayout({ alfW: Math.min(ALF.max, Math.max(ALF.min, width)) }));

  /** What searching can run besides going to a page or a conversation: in the ask bar, and in ⌘K's palette. */
  const commands: FindCommand[] = [
    { id: "new", label: t("cmd.new"), icon: "plus", run: () => select(null) },
    { id: "alfred", label: t(alfredMode === "closed" ? "cmd.openAlfred" : "cmd.closeAlfred"), icon: "panel", hint: `${MOD}.`, run: toggleAlfred },
    ...(phone ? [] : [{ id: "nav", label: t(navMode === "full" ? "cmd.foldNav" : "cmd.unfoldNav"), icon: "rail" as const, hint: `${MOD}\\`, run: toggleNav }]),
    { id: "language", label: t("cmd.language"), icon: "chat", run: switchLanguage },
    getScheme() === "dark"
      ? { id: "scheme", label: t("scheme.to.light"), icon: "sun" as const, run: () => setAppearance("light") }
      : { id: "scheme", label: t("scheme.to.dark"), icon: "moon" as const, run: () => setAppearance("dark") },
  ];
  const find: FindSources = { pages, commands, conversations: state.conversations, onPage: goPage, onSelect: select };

  const panel = (
    <AlfredPanel selected={selected} figure={figure} wide={alfredMode === "wide"} phone={phone}
      live={live} highlighted={highlighted} view={view} pageTitle={pageTitle} automationTitle={automationOf} onEvent={onEvent} onView={onView} onStarted={onStarted}
      onWide={() => setLayout({ alfred: layout.alfred === "wide" ? "open" : "wide" })}
      onClose={() => (phone ? setSheet(null) : setLayout({ alfred: "closed" }))} />
  );

  return (
    <div className="workspace" data-nav={phone ? undefined : navMode} data-alfred={alfredMode} data-phone={phone || undefined}
      data-sheet={sheet ?? undefined} style={{ "--nav-px": `${size.nav}px`, "--alf-px": `${size.alf}px` } as CSSProperties}>
      {!phone && <Topbar navOpen={navMode === "full"} onNav={toggleNav} mode={mode} onMode={hasDev ? switchMode : undefined} onLanguage={switchLanguage}
        heading={current && alfredMode !== "wide" ? { title: current.title, icon: current.icon, k: current.k, summary: bare ? undefined : current.summary?.(state.modules[moduleOf(current)], state) } : undefined}
        system={pages.filter((page) => page.group === "system")} page={current?.key ?? ""} onPage={goPage} />}
      {(phone ? sheet === "nav" : navMode === "full") && (
        <Nav state={state} pages={pages} page={current?.key ?? ""} mode={phone ? "all" : mode} selected={selected} session={bare ? route.session : null}
          onSession={openSession} connection={connection}
          onPage={goPage} onSelect={(id) => { setSheet(null); select(id); }} onClose={phone ? () => setSheet(null) : undefined} onLanguage={switchLanguage} />
      )}
      {phone && sheet === "nav" && <div className="scrim" onClick={() => setSheet(null)} />}

      <main className="page" data-k={current?.k} data-bare={bare || undefined}>
        {current ? (
          <>
            {/* The top bar carries the page's name and facts; a phone has no top bar, so there the page says them. */}
            {!bare && phone && (
              <header className="page-head">
                <h1><Icon name={current.icon} />{current.title}</h1>
                {current.summary && <p className="page-sub">{current.summary(state.modules[moduleOf(current)], state)}</p>}
              </header>
            )}
            <div className="page-body">{current.render({
              snapshot: state.modules[moduleOf(current)], fresh, areas: state.areas ?? [], state, focus: inboxFocus, onFocused, openConversation, line,
              dev: { session: route.session, onSession: openSession, live, highlighted, onEvent, pageTitle, automationTitle: automationOf },
            })}</div>
            {/* Under the page: the page's own controls are at its top, Alfred and search at its foot. */}
            {barHere && (
              <AskBar state={state} selected={selected} figure={figure} live={live} suggestions={view?.suggestions ?? []} find={find} page={current.key} about={about} onAbout={setAbout}
                onAsk={ask} onOpen={showAlfred} onProposal={showProposal} onEvent={onEvent} />
            )}
          </>
        ) : (
          <div className="empty"><p className="empty-title">{t("page.none")}</p><p className="quiet">{t("page.noneHint")}</p></div>
        )}
      </main>

      {alfredMode !== "closed" && panel}

      {!phone && (
        <>
          {navMode === "full" && <div className="resizer resizer-nav" onPointerDown={(event) => { navStart.current = layout.navW; navDrag(event); }}
            onDoubleClick={toggleNav} title={t("resize.nav")} />}
          {alfredMode === "open" && (
            <div className="resizer resizer-alf" onPointerDown={alfDrag} onDoubleClick={() => setLayout({ alfW: ALF.def })} title={t("resize.alf")} />
          )}
        </>
      )}

      {phone && sheet !== "alfred" && (
        <Dock state={state} pages={pages} page={current?.key ?? ""} figure={figure} onPage={goPage}
          onAlfred={() => (asking || bare ? setSheet("alfred") : setAsking(true))} onMenu={() => setSheet("nav")}
          ask={asking && !bare ? (
            <AskBar dock state={state} selected={selected} figure={figure} live={live} suggestions={view?.suggestions ?? []} find={find} page={current?.key} about={about} onAbout={setAbout}
              onAsk={ask} onOpen={() => setSheet("alfred")} onProposal={showProposal} onEvent={onEvent} onBack={() => { setAsking(false); setAbout(null); }} />
          ) : undefined} />
      )}

      {palette && (
        <Palette pages={pages} conversations={state.conversations} onPage={goPage} onSelect={select} onAsk={askAnywhere} onClose={() => setPalette(false)} actions={commands} />
      )}

      <Says<Notice>
        items={shown} id={(notice) => notice.id} lines={noticeSaid} stayMs={(notice) => STAY_MS[notice.kind] ?? 25_000}
        remove={unshow} onMood={setSpeaking} done={(notice, outcome: Outcome) => {
          if (outcome === "timeout") return; // left in 通知, not acknowledged
          acknowledge(notice);
          if (outcome !== "open") return;
          if (notice.kind === "run_interrupted") api.resume(String(notice.payload.runId)).catch(() => {});
          else if ((notice.kind === "proposal" || notice.kind === "outbound") && notice.payload.proposalId) showProposal(String(notice.payload.proposalId));
          else if (notice.payload.runId) openRun(String(notice.payload.runId), String(notice.payload.conversationId ?? "") || undefined);
        }}
      />
    </div>
  );
}
