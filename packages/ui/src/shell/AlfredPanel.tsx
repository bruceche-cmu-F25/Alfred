import type { CoreEvent, Run, StateResponse } from "@alfred/protocol";
import type { FigureState } from "../entity/tesseract.js";
import { Conversation } from "../Conversation.tsx";
import { Figure } from "./Figure.tsx";
import { Icon } from "./icons.tsx";
import { waitingCount } from "./inbox.ts";
import { t } from "../i18n/index.ts";
import { MOD } from "./Nav.tsx";
import type { PageView } from "./pages.tsx";

const WAITING = new Set<Run["state"]>(["waiting_permission", "waiting_input"]);

/** What the figure shows, from the world as this device sees it: greeting on open, amber when anything waits for
 * you (a question, a proposal), speaking while a reply streams in the open conversation, the turning nut while any
 * run works, else calm. */
export function figureState(state: StateResponse, selected: string | null, live: Readonly<Record<string, string>>, greeting: boolean): FigureState {
  if (greeting) return "hello";
  if (waitingCount(state) > 0) return "notice";
  if (state.runs.some((run) => run.conversationId === selected && run.state === "running" && live[run.id])) return "speak";
  if (state.runs.some((run) => run.state === "running")) return "work";
  if (state.runs.some((run) => run.state === "queued")) return "think";
  return "rest";
}

/** One line under Alfred's name: what the open conversation is doing, or, while it is doing nothing, what Alfred
 * makes of the page you are on. */
export function statusLine(state: StateResponse, selected: string | null, idle?: string): string {
  const runs = state.runs.filter((run) => run.conversationId === selected);
  const waiting = runs.find((run) => WAITING.has(run.state));
  if (waiting) return t("panel.waiting", { what: waiting.request?.question ?? waiting.goal });
  const working = runs.find((run) => run.state === "running" || run.state === "queued");
  if (working) return t("panel.working", { goal: working.goal });
  return idle ?? state.conversations.find((candidate) => candidate.id === selected)?.title ?? t("conv.emptyTitle");
}

export interface AlfredPanelProps {
  state: StateResponse;
  selected: string | null;
  figure: FigureState;
  wide: boolean;
  phone: boolean;
  live: Readonly<Record<string, string>>;
  highlighted: ReadonlySet<string>;
  /** The page beside Alfred: what a question asked now is about. */
  view?: PageView;
  /** A page's title by its key, for "asked on" labels. */
  pageTitle(view: string): string | undefined;
  /** An automation's name by its id, for the runs it started. */
  automationTitle(id: string): string | undefined;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  onView(module: string, view: string): void;
  onStarted(conversationId: string): void;
  onWide(): void;
  onClose(): void;
}

/** Alfred beside the page: the figure, one line on what it is doing, and the open conversation. */
export function AlfredPanel({ state, selected, figure, wide, phone, live, highlighted, view, pageTitle, automationTitle, onEvent, onView, onStarted, onWide, onClose }: AlfredPanelProps) {
  return (
    <aside className="alfred" aria-label="Alfred">
      <header className="alf-head">
        <Figure state={figure} size={36} />
        <div className="alf-who">
          <p className="alf-name">Alfred{view && !wide && <span className="alf-looking">{t("panel.looking", { page: view.title })}</span>}</p>
          <p className="alf-line">{statusLine(state, selected, view?.headline)}</p>
        </div>
        <div className="alf-tools">
          {!phone && (
            <button type="button" className="icon-btn" onClick={onWide} aria-label={t(wide ? "panel.narrow" : "panel.wide")} title={t(wide ? "panel.narrow" : "panel.wide")}>
              <Icon name={wide ? "narrow" : "wide"} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("panel.close")} title={phone ? t("panel.close") : t("panel.closeKey", { key: `${MOD}.` })}>
            <Icon name={phone ? "down" : "panel"} />
          </button>
        </div>
      </header>
      <Conversation key={selected ?? "new"} id={selected} live={live} highlighted={highlighted}
        context={wide ? undefined : view?.context} suggestions={wide ? [] : view?.suggestions ?? []} pageTitle={pageTitle} automationTitle={automationTitle}
        onEvent={onEvent} onView={onView} onStarted={onStarted} />
    </aside>
  );
}
