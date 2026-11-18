import { useCallback, useEffect, useRef, useState } from "react";
import type { AwayDigest, Notice, StateResponse } from "@alfred/protocol";
import type { TodoSnapshot } from "@alfred/module-todo/types";
import { api, deviceId } from "./api.ts";
import { Conversation } from "./Conversation.tsx";
import { desktop } from "./desktop.ts";
import { Sidebar, type Place } from "./Sidebar.tsx";
import { Todos } from "./Todos.tsx";
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

/** The selected conversation lives in the address (#c=<id>), so a reload keeps it. */
function useSelection(): [string | null, (id: string | null) => void] {
  const read = () => new URLSearchParams(location.hash.slice(1)).get("c");
  const [selected, setSelected] = useState<string | null>(read);
  useEffect(() => {
    const update = () => setSelected(read());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const select = useCallback((id: string | null) => {
    history.replaceState(null, "", id ? `#c=${id}` : location.pathname);
    setSelected(id);
  }, []);
  return [selected, select];
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
  if (notice.kind === "run_interrupted") return `「${goal}」中断了，没有自动重做。`;
  if (notice.kind === "run_request") return `「${goal}」在等你：${String(notice.payload.question ?? "")}`;
  if (notice.kind === "run_result") return `「${goal}」有结果了。`;
  if (notice.kind === "welcome") {
    const { greeting, summary } = welcomeLines(notice.payload as unknown as AwayDigest, null);
    return `${greeting}${summary}`;
  }
  return goal || notice.kind;
}

function places(state: StateResponse): Place[] {
  return Object.entries(state.views).flatMap(([module, views]) => views.map((view) => ({
    module, view: view.id, title: view.title,
    count: module === "todo" ? (state.modules.todo as TodoSnapshot | undefined)?.todos.filter((todo) => !todo.done).length : undefined,
  })));
}

export function App() {
  const { state, connection, error, fresh, live, onEvent } = useAlfred();
  const [selected, select] = useSelection();
  const [pane, setPane] = useState<{ module: string; view: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(new Set());

  const highlight = useCallback((runId: string) => {
    setHighlighted((current) => new Set(current).add(runId));
    window.setTimeout(() => setHighlighted((current) => { const next = new Set(current); next.delete(runId); return next; }), 2400);
  }, []);
  const onPresented = useCallback((notice: Notice) => {
    const runId = String(notice.payload.runId ?? "");
    if (runId) highlight(runId);
  }, [highlight]);
  const { shown, dismiss } = useNotices(state?.notices ?? [], selected, onPresented);

  const openRun = useCallback((runId: string, conversationId?: string) => {
    const go = (conversation: string) => {
      select(conversation);
      highlight(runId);
      window.setTimeout(() => document.getElementById(`run-${runId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
    };
    if (conversationId) go(conversationId);
    else api.run(runId).then(({ run }) => go(run.conversationId)).catch(() => {});
  }, [select, highlight]);

  const onView = useCallback((module: string, view: string) => setPane({ module, view }), []);
  const choose = useCallback((id: string | null) => { select(id); setSidebarOpen(false); }, [select]);

  // The Mac app: a notification was clicked, or the hotkey brought the window up.
  useEffect(() => desktop?.onFocusRun((runId) => openRun(runId)), [openRun]);
  useEffect(() => desktop?.onFocusComposer(() => {
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }), []);

  if (!state) {
    return (
      <main className="boot">
        <p className="wordmark">Alfred</p>
        <p className="quiet">{error ? `${error}。主节点在运行吗？` : "正在连接主节点…"}</p>
      </main>
    );
  }

  const todos = state.modules.todo as TodoSnapshot | undefined;
  const paneTitle = pane ? state.views[pane.module]?.find((view) => view.id === pane.view)?.title ?? pane.module : "";

  return (
    <div className="shell" data-pane={pane ? "open" : undefined} data-sidebar={sidebarOpen ? "open" : undefined}>
      <Sidebar
        conversations={state.conversations} selected={selected} places={places(state)}
        openPlace={pane ? `${pane.module}.${pane.view}` : null} connection={connection}
        onSelect={choose}
        onPlace={(place) => { setPane((current) => current?.module === place.module && current.view === place.view ? null : { module: place.module, view: place.view }); setSidebarOpen(false); }}
      />
      <button type="button" className="sidebar-toggle" aria-label="对话列表" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M4 10h12M4 14h12" /></svg>
      </button>
      <main className="main">
        <Conversation key={selected ?? "new"} id={selected} live={live} highlighted={highlighted} onEvent={onEvent} onView={onView} onStarted={select} />
      </main>
      {pane && (
        <aside className="pane" aria-label={paneTitle}>
          <header className="pane-head">
            <h2>{paneTitle}</h2>
            <button type="button" className="pane-close" aria-label="关掉面板" onClick={() => setPane(null)}>×</button>
          </header>
          {pane.module === "todo" && todos ? <Todos snapshot={todos} fresh={fresh} /> : <p className="quiet empty-list">这个视图还不能显示。</p>}
        </aside>
      )}
      {shown.length > 0 && (
        <aside className="notices" aria-live="polite">
          {shown.map((notice) => (
            <div className="notice" key={notice.id} role="status">
              <p>{noticeText(notice)}</p>
              <div className="notice-actions">
                {notice.kind === "run_interrupted" && (
                  <button type="button" onClick={() => { api.resume(String(notice.payload.runId)).catch(() => {}); dismiss(notice); }}>继续</button>
                )}
                {(notice.kind === "run_result" || notice.kind === "run_request") && notice.payload.runId ? (
                  <button type="button" onClick={() => { openRun(String(notice.payload.runId), String(notice.payload.conversationId ?? "") || undefined); dismiss(notice); }}>
                    {notice.kind === "run_request" ? "去回答" : "查看"}
                  </button>
                ) : null}
                <button type="button" className="ghost" onClick={() => dismiss(notice)}>知道了</button>
              </div>
            </div>
          ))}
        </aside>
      )}
    </div>
  );
}
