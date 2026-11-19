import type { CoreEvent, Run, StateResponse } from "@alfred/protocol";
import type { FigureState } from "../entity/tesseract.js";
import { Conversation } from "../Conversation.tsx";
import { Figure } from "./Figure.tsx";
import { Icon } from "./icons.tsx";
import { waitingCount } from "./inbox.ts";
import { MOD } from "./Nav.tsx";

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

/** One line under Alfred's name: what the open conversation is doing. */
export function statusLine(state: StateResponse, selected: string | null): string {
  const conversation = state.conversations.find((candidate) => candidate.id === selected);
  if (!conversation) return "想让我做点什么？";
  const runs = state.runs.filter((run) => run.conversationId === selected);
  const waiting = runs.find((run) => WAITING.has(run.state));
  if (waiting) return `在等你：${waiting.request?.question ?? waiting.goal}`;
  const working = runs.find((run) => run.state === "running" || run.state === "queued");
  if (working) return `在办：${working.goal}`;
  return conversation.title;
}

export interface AlfredPanelProps {
  state: StateResponse;
  selected: string | null;
  figure: FigureState;
  wide: boolean;
  phone: boolean;
  live: Readonly<Record<string, string>>;
  highlighted: ReadonlySet<string>;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  onView(module: string, view: string): void;
  onStarted(conversationId: string): void;
  onWide(): void;
  onClose(): void;
}

/** Alfred beside the page: the figure, one line on what it is doing, and the open conversation. */
export function AlfredPanel({ state, selected, figure, wide, phone, live, highlighted, onEvent, onView, onStarted, onWide, onClose }: AlfredPanelProps) {
  return (
    <aside className="alfred" aria-label="Alfred">
      <header className="alf-head">
        <Figure state={figure} size={36} />
        <div className="alf-who">
          <p className="alf-name">Alfred</p>
          <p className="alf-line">{statusLine(state, selected)}</p>
        </div>
        <div className="alf-tools">
          {!phone && (
            <button type="button" className="icon-btn" onClick={onWide} aria-label={wide ? "回到并排" : "展开成整页"} title={wide ? "回到并排" : "展开成整页"}>
              <Icon name={wide ? "narrow" : "wide"} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="收起" title={phone ? "收起" : `收起（${MOD}.）`}>
            <Icon name={phone ? "down" : "panel"} />
          </button>
        </div>
      </header>
      <Conversation key={selected ?? "new"} id={selected} live={live} highlighted={highlighted} onEvent={onEvent} onView={onView} onStarted={onStarted} />
    </aside>
  );
}
