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
}

/** The phone's bottom bar: the first pages, Alfred in the middle, and the conversations. */
export function Dock({ state, pages, page, figure, onPage, onAlfred, onConversations }: DockProps) {
  const shown = pages.slice(0, 4);
  const half = Math.ceil(shown.length / 2);
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
    <nav className="dock" aria-label={t("nav.label")}>
      {shown.slice(0, half).map(button)}
      <button type="button" className="dock-alfred" onClick={onAlfred} aria-label="Alfred"><Figure state={figure} size={34} /></button>
      {shown.slice(half).map(button)}
      <button type="button" onClick={onConversations}>
        <Icon name="chat" /><span>{t("nav.conversations")}</span>{waiting ? <span className="count">{waiting}</span> : null}
      </button>
    </nav>
  );
}
