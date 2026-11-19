/** The Code page: development sessions in the user's projects (docs/design/dev-mode.md).
 *
 * With no session open it is the new-session screen: one composer, with the project and the permission mode chosen
 * under it (adding and trusting a folder happen here, on the home node's machine only); the first message opens the
 * session. With one open it is that session, full page: the same conversation component as everyday ones, without a
 * page to ask from. Behind both moves a field of characters (shell/AsciiField.tsx): this is where code is written.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Conversation as ConversationRow, CoreEvent, Project, SessionChanges, SessionMode, StateResponse } from "@alfred/protocol";
import { ApiError, api } from "./api.ts";
import { Conversation } from "./Conversation.tsx";
import { desktop } from "./desktop.ts";
import { Diff } from "./Diff.tsx";
import { t, type Key } from "./i18n/index.ts";
import { AsciiField } from "./shell/AsciiField.tsx";
import { Figure } from "./shell/Figure.tsx";
import { Icon } from "./shell/icons.tsx";
import { when } from "./shell/Nav.tsx";

export interface DevProps {
  state: StateResponse;
  /** The open session, or null for the new-session screen. */
  session: string | null;
  onSession(id: string | null): void;
  live: Readonly<Record<string, string>>;
  highlighted: ReadonlySet<string>;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  pageTitle(view: string): string | undefined;
  automationTitle(id: string): string | undefined;
}

/** Development sessions, most recently active first. */
export const sessionsOf = (state: StateResponse, projectId?: string) =>
  state.conversations.filter((conversation) => conversation.projectId && (!projectId || conversation.projectId === projectId));

export function Dev(props: DevProps) {
  const { state, session } = props;
  const open = session ? state.conversations.find((conversation) => conversation.id === session) : undefined;
  return (
    <div className="dev-stage" data-in={session ? "session" : "new"}>
      <AsciiField />
      {!session && <div className="dev-drag" aria-hidden="true" />}
      {session ? <Session {...props} id={session} conversation={open} /> : <NewSession state={state} onSession={props.onSession} />}
    </div>
  );
}

const noView = () => {};

const MODES: SessionMode[] = ["plan", "ask", "edits"];
/** The project picker's last choice: not a project, but adding one. */
const ADD = "+";
const PANEL_KEY = "alfred.devPanel";

function Session({ id, conversation, state, onSession, live, highlighted, onEvent, pageTitle, automationTitle }: DevProps & { id: string; conversation?: ConversationRow }) {
  const project = state.projects?.find((candidate) => candidate.id === conversation?.projectId);
  // Open by default where there is room beside the session; on a narrow screen it opens over it, when asked.
  const [panel, setPanel] = useState(() => { try { return matchMedia("(min-width: 1001px)").matches && localStorage.getItem(PANEL_KEY) !== "closed"; } catch { return false; } });
  const [changes, setChanges] = useState<SessionChanges | null>(null);
  const [open, setOpen] = useState<{ path: string; diff: string | null } | null>(null);
  const togglePanel = () => setPanel((value) => { try { localStorage.setItem(PANEL_KEY, value ? "closed" : "open"); } catch { /* not remembered */ } return !value; });

  // The changed files, read again whenever this session's runs change something or finish.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.changes(id).then((next) => { if (alive) setChanges(next); }).catch(() => {});
    void load();
    const off = onEvent((event) => {
      if (event.kind !== "file.changed" && event.kind !== "run.completed" && event.kind !== "run.failed") return;
      if (timer.current === null) timer.current = window.setTimeout(() => { timer.current = null; void load(); }, 300);
    });
    return () => { alive = false; off(); };
  }, [id, onEvent]);
  const show = (path: string) => { setOpen({ path, diff: null }); api.diff(id, path).then(({ diff }) => setOpen({ path, diff: diff ?? "" })).catch(() => setOpen({ path, diff: "" })); };

  const files = changes?.files ?? [];
  const added = files.reduce((sum, file) => sum + file.added, 0), removed = files.reduce((sum, file) => sum + file.removed, 0);
  const mode = conversation?.mode ?? "plan";
  return (
    <div className="dev-layout" data-panel={panel || undefined}>
      <section className="dev-session">
        <header className="dev-bar">
          <button type="button" className="icon-btn" onClick={() => onSession(null)} aria-label={t("dev.back")} title={t("dev.back")}><Icon name="back" /></button>
          {project && <span className="dev-where" title={project.path}><Icon name="folder" />{project.name}{changes?.branch ? ` · ${changes.branch}` : ""}</span>}
          <button type="button" className="icon-btn dev-panel-toggle" onClick={togglePanel} aria-pressed={panel} aria-label={t("dev.panel")} title={t("dev.panel")}><Icon name="panel" /></button>
        </header>
        <Conversation key={id} id={id} live={live} highlighted={highlighted} suggestions={[]} pageTitle={pageTitle} automationTitle={automationTitle}
          onEvent={onEvent} onView={noView} onStarted={noView} />
        {open && (
          <div className="dev-drawer" role="dialog" aria-label={open.path}>
            <header><button type="button" className="icon-btn" onClick={() => setOpen(null)} aria-label={t("common.close")}><Icon name="back" /></button><span className="p">{open.path}</span></header>
            {open.diff === null ? <p className="quiet small">…</p> : open.diff ? <Diff patch={open.diff} /> : <p className="quiet small">{t("dev.noDiff")}</p>}
          </div>
        )}
      </section>
      {panel && (
        <aside className="dev-panel" aria-label={t("dev.panel")}>
          <section>
            <h3>{t("dev.env")}</h3>
            {project && <p className="kv" title={project.path}><Icon name="folder" /><span className="mono">{project.path}</span></p>}
            <p className="kv"><Icon name="code" /><span className="mono">{changes?.branch ?? t("dev.noGit")}</span></p>
          </section>
          <section>
            <h3>{t("mode.title")}</h3>
            <div className="dev-modes" role="radiogroup" aria-label={t("mode.title")}>
              {MODES.map((candidate) => (
                <button type="button" key={candidate} role="radio" aria-checked={mode === candidate} data-mode={candidate}
                  onClick={() => { if (candidate !== mode) api.updateConversation(id, { mode: candidate }).catch(() => {}); }}>
                  <b>{t(`mode.${candidate}` as Key)}</b><span>{t(`mode.${candidate}.hint` as Key)}</span>
                </button>
              ))}
            </div>
            <p className="small quiet">{t("mode.outside")}</p>
          </section>
          <section>
            <h3>{t("dev.changes")}{files.length > 0 && <span className="mono"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>}</h3>
            {files.length === 0 ? <p className="small quiet">{t("dev.noChanges")}</p> : (
              <ul className="dev-files">
                {files.map((file) => (
                  <li key={file.path}>
                    <button type="button" onClick={() => show(file.path)} title={file.path} aria-current={open?.path === file.path || undefined}>
                      <span className="p">{file.path}</span>
                      {file.created && <span className="new">{t("dev.new1")}</span>}
                      <span className="add">+{file.added}</span>{file.removed > 0 && <span className="del">−{file.removed}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {changes?.base && <p className="small quiet">{t("dev.since", { base: changes.base.slice(0, 7) })}</p>}
          </section>
        </aside>
      )}
    </div>
  );
}

function NewSession({ state, onSession }: { state: StateResponse; onSession(id: string): void }) {
  const projects = state.projects ?? [];
  const [chosen, setChosen] = useState<string | null>(() => projects.find((project) => project.trustedAt)?.id ?? null);
  const [mode, setMode] = useState<SessionMode>("ask");
  const [draft, setDraft] = useState("");
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === chosen);
  const fail = (reason: unknown) => setError(reason instanceof ApiError && reason.code === "local_only" ? t("dev.addLocal") : reason instanceof Error ? reason.message : String(reason));

  const add = async (folder: string | null) => {
    if (!folder?.trim()) return;
    setError(null);
    try {
      const added = await api.addProject(folder.trim());
      setChosen(added.id);
      setPath("");
      setAdding(false);
    } catch (reason) { fail(reason); }
  };
  const pick = () => {
    // The Mac app has the system's folder picker; a browser on the same machine types the path.
    if (desktop?.pickFolder) void desktop.pickFolder().then(add, fail);
    else setAdding((value) => !value);
  };
  const trust = (target: Project) => { setError(null); api.trustProject(target.id).catch(fail); };

  const start = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || !project?.trustedAt || busy) return;
    setBusy(true);
    setError(null);
    api.startSession(project.id, text, mode)
      .then(async (conversation) => { await api.submit(text, conversation.id); onSession(conversation.id); })
      .catch((reason) => { fail(reason); setBusy(false); });
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) start(event);
  };
  const recent = sessionsOf(state).slice(0, 5);
  const nameOf = (projectId: string | null) => projects.find((candidate) => candidate.id === projectId)?.name ?? "";

  return (
    <div className="dev-new">
      <div className="dev-new-in">
        <header className="dev-new-head">
          <Figure state="hello" size={40} />
          <h2>{t("dev.new")}</h2>
        </header>

        <form className="composer dev-composer" onSubmit={start}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey}
            rows={Math.min(6, Math.max(2, draft.split("\n").length))} maxLength={8000} aria-label={t("composer.label")}
            placeholder={project?.trustedAt ? t("dev.ask", { name: project.name }) : t("dev.pick")} disabled={!project?.trustedAt} />
          <div className="composer-bar">
            <label className="pick" title={project?.path ?? t("dev.projects")}>
              <Icon name="folder" />
              <select aria-label={t("dev.projects")} value={chosen ?? ""} onChange={(event) => { if (event.target.value === ADD) pick(); else setChosen(event.target.value); }}>
                {!project && <option value="" disabled>{t("dev.projects")}</option>}
                {projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.trustedAt ? "" : ` · ${t("dev.untrusted")}`}</option>)}
                <option value={ADD}>{t("dev.add")}</option>
              </select>
            </label>
            <label className="pick mode" data-mode={mode} title={t("mode.title")}>
              <Icon name="shield" />
              <select aria-label={t("mode.title")} value={mode} onChange={(event) => setMode(event.target.value as SessionMode)}>
                {MODES.map((candidate) => <option key={candidate} value={candidate}>{t(`mode.${candidate}` as Key)}</option>)}
              </select>
            </label>
            <span className="grow" />
            <button type="submit" className="send" disabled={!draft.trim() || !project?.trustedAt || busy} aria-label={t("composer.send")}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
            </button>
          </div>
        </form>
        {/* What the two choices under the composer mean, in one line. */}
        <p className="dev-note">{project && <span className="mono" title={project.path}>{project.path}</span>}<span>{t(`mode.${mode}.hint` as Key)}</span></p>
        {adding && (
          <form className="dev-add" onSubmit={(event) => { event.preventDefault(); void add(path); }}>
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder={t("dev.addPath")} aria-label={t("dev.addPath")} autoFocus spellCheck={false} />
            <button type="submit" disabled={!path.trim()}>{t("dev.addButton")}</button>
          </form>
        )}
        {error && <p className="problem small" role="alert">{error}</p>}

        {project && !project.trustedAt && (
          <div className="dev-trust" role="group" aria-label={t("dev.trustTitle", { name: project.name })}>
            <p><b>{t("dev.trustTitle", { name: project.name })}</b></p>
            <ul><li>{t("dev.trust1")}</li><li>{t("dev.trust2")}</li><li>{t("dev.trust3")}</li></ul>
            <div className="dev-actions">
              <button type="button" onClick={() => trust(project)}>{t("dev.trust")}</button>
              <button type="button" className="ghost" onClick={() => setChosen(projects.find((candidate) => candidate.trustedAt)?.id ?? null)}>{t("dev.trustNo")}</button>
            </div>
          </div>
        )}

        {recent.length > 0 && (
          <div className="dev-box">
            <p className="dev-box-label">{t("dev.recent")}</p>
            {recent.map((conversation) => (
              <button type="button" key={conversation.id} className="dev-recent" onClick={() => onSession(conversation.id)}>
                <span className="st" aria-hidden="true">{conversation.attention > 0 ? <span className="mark" data-k="warm" /> : conversation.busy > 0 ? <span className="pulse" /> : <span className="mark dim" />}</span>
                <span className="t">{conversation.title}</span>
                <span className="p">{nameOf(conversation.projectId)}</span>
                <span className="time">{when(conversation.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
