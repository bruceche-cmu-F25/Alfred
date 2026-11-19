/** The Code page: development sessions in the user's projects (docs/design/dev-mode.md).
 *
 * With no session open it is the new-session screen: pick a project (adding and trusting a folder happen here, on
 * the home node's machine only), write the first message, and the session opens. With one open it is that session,
 * full page: the same conversation component as everyday ones, without a page to ask from.
 */
import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { Conversation as ConversationRow, CoreEvent, Project, StateResponse } from "@alfred/protocol";
import { ApiError, api } from "./api.ts";
import { Conversation } from "./Conversation.tsx";
import { desktop } from "./desktop.ts";
import { t } from "./i18n/index.ts";
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
  if (session) return <Session {...props} id={session} conversation={open} />;
  return <NewSession state={state} onSession={props.onSession} />;
}

const noView = () => {};

function Session({ id, conversation, state, onSession, live, highlighted, onEvent, pageTitle, automationTitle }: DevProps & { id: string; conversation?: ConversationRow }) {
  const project = state.projects?.find((candidate) => candidate.id === conversation?.projectId);
  return (
    <section className="dev-session">
      <header className="dev-bar">
        <button type="button" className="icon-btn" onClick={() => onSession(null)} aria-label={t("dev.back")} title={t("dev.back")}><Icon name="back" /></button>
        {project && <span className="dev-where" title={project.path}><Icon name="folder" />{project.name}</span>}
        <span className="dev-mode" title={t("dev.readOnlyTitle")}>{t("dev.readOnly")}</span>
      </header>
      <Conversation key={id} id={id} live={live} highlighted={highlighted} suggestions={[]} pageTitle={pageTitle} automationTitle={automationTitle}
        onEvent={onEvent} onView={noView} onStarted={noView} />
    </section>
  );
}

function NewSession({ state, onSession }: { state: StateResponse; onSession(id: string): void }) {
  const projects = state.projects ?? [];
  const [chosen, setChosen] = useState<string | null>(() => projects.find((project) => project.trustedAt)?.id ?? null);
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
    api.startSession(project.id, text)
      .then(async (conversation) => { await api.submit(text, conversation.id); onSession(conversation.id); })
      .catch((reason) => { fail(reason); setBusy(false); });
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) start(event);
  };
  const recent = sessionsOf(state).slice(0, 8);
  const nameOf = (projectId: string | null) => projects.find((candidate) => candidate.id === projectId)?.name ?? "";

  return (
    <div className="dev-new">
      <div className="dev-new-in">
        <header className="dev-new-head">
          <Figure state="hello" size={56} />
          <h2>{t("dev.new")}</h2>
          <p className="quiet">{t("dev.newHint")}</p>
        </header>

        <div className="dev-box" role="radiogroup" aria-label={t("dev.projects")}>
          <p className="dev-box-label">{t("dev.projects")}</p>
          {projects.map((candidate) => (
            <button type="button" key={candidate.id} className="dev-project" role="radio" aria-checked={candidate.id === chosen} onClick={() => setChosen(candidate.id)}>
              <span className="tick" aria-hidden="true"><Icon name={candidate.id === chosen ? "check" : "folder"} /></span>
              <span className="n">{candidate.name}</span>
              <span className="meta">{candidate.trustedAt ? t("dev.sessions", { n: sessionsOf(state, candidate.id).length }) : t("dev.untrusted")}</span>
              <span className="path">{candidate.path}</span>
            </button>
          ))}
          <button type="button" className="dev-project add" onClick={pick}>
            <span className="tick" aria-hidden="true"><Icon name="plus" /></span>
            <span className="n">{t("dev.add")}</span>
            <span className="path">{desktop?.pickFolder ? t("dev.addMac") : t("dev.addLocal")}</span>
          </button>
          {adding && (
            <form className="dev-add" onSubmit={(event) => { event.preventDefault(); void add(path); }}>
              <input value={path} onChange={(event) => setPath(event.target.value)} placeholder={t("dev.addPath")} aria-label={t("dev.addPath")} autoFocus spellCheck={false} />
              <button type="submit" disabled={!path.trim()}>{t("dev.addButton")}</button>
            </form>
          )}
        </div>

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

        <form className="composer dev-composer" onSubmit={start}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey}
            rows={Math.min(6, Math.max(2, draft.split("\n").length))} maxLength={8000} aria-label={t("composer.label")}
            placeholder={project?.trustedAt ? t("dev.ask", { name: project.name }) : t("dev.pick")} disabled={!project?.trustedAt} />
          <div className="composer-bar">
            <span className="grow" />
            <button type="submit" className="send" disabled={!draft.trim() || !project?.trustedAt || busy} aria-label={t("composer.send")}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
            </button>
          </div>
        </form>
        {error && <p className="problem small" role="alert">{error}</p>}

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
