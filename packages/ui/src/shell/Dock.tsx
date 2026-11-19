import type { ReactNode } from "react";
import type { StateResponse } from "@alfred/protocol";
import type { FigureState } from "../entity/tesseract.js";
import { Figure } from "./Figure.tsx";
import { t } from "../i18n/index.ts";
import { Icon } from "./icons.tsx";
import { moduleOf, type PageDef } from "./pages.tsx";

export interface DockProps {
  state: StateResponse;
  pages: PageDef[];
  page: string;
  figure: FigureState;
  onPage(key: string): void;
  onAlfred(): void;
  onConversations(): void;
  /** The ask bar, while the user is talking to Alfred: it takes the tabs' place, and Alfred stays where it is. */
  ask?: ReactNode;
}

/** At most this many pages get a tab; everything else is a tap away in the sheet that "Conversations" opens. */
const TABS = 3;

/** The phone's bottom bar: the daily pages and the conversations side by side, and Alfred on its own at the right.
 * Tapping Alfred turns the tabs into the ask bar; tapping it again opens the whole conversation. */
export function Dock({ state, pages, page, figure, onPage, onAlfred, onConversations, ask }: DockProps) {
  const shown = pages.filter((item) => item.group === "work").slice(0, TABS);
  const waiting = state.conversations.reduce((sum, conversation) => sum + conversation.attention, 0);
  const button = (item: PageDef) => {
    const count = item.badge?.(state.modules[moduleOf(item)], state);
    return (
      <button type="button" key={item.key} data-k={item.k} aria-current={page === item.key ? "page" : undefined} onClick={() => onPage(item.key)}>
        <Icon name={item.icon} /><span>{item.title}</span>{count ? <span className="count">{count}</span> : null}
      </button>
    );
  };
  return (
    <nav className="dock" aria-label={t("nav.label")} data-asking={ask ? "" : undefined}>
      {ask ?? (
        <div className="dock-tabs">
          {shown.map(button)}
          <button type="button" onClick={onConversations}>
            <Icon name="chat" /><span>{t("nav.conversations")}</span>{waiting ? <span className="count">{waiting}</span> : null}
          </button>
        </div>
      )}
      <button type="button" className="dock-alfred" onClick={onAlfred} aria-label="Alfred"><Figure state={figure} size={34} anchor /></button>
    </nav>
  );
}
