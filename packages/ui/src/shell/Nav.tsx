import type { Conversation, StateResponse } from "@alfred/protocol";
import { api, type Connection } from "../api.ts";
import { getLocale, intlLocale, t } from "../i18n/index.ts";
import { origin, setAppearance, useScheme } from "../scheme.ts";
import { Icon } from "./icons.tsx";
import { moduleOf, type PageDef } from "./pages.tsx";
import type { NavMode } from "./layout.ts";

const CONNECTION = { connecting: "nav.connecting", live: "nav.live", reconnecting: "nav.reconnecting" } as const;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";

/** "08:20" today, "yesterday", or the date ("11月16日" / "Nov 16"). */
export function when(iso: string): string {
  const at = new Date(iso), now = new Date();
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (days === 1) return t("nav.yesterday");
  return at.toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

export interface NavProps {
  state: StateResponse;
  pages: PageDef[];
  page: string;
  mode: NavMode;
  selected: string | null;
  /** The development session open on the Code page, if any. */
  session: string | null;
  onSession(id: string | null): void;
  connection: Connection;
  onPage(key: string): void;
  onSelect(id: string | null): void;
  onFold(): void;
  onPalette(): void;
  /** Rail only: the conversations live in Alfred's panel. */
  onConversations(): void;
  /** Shown as a sheet (phone): the top button closes it instead of folding. */
  sheet?: boolean;
  /** Switch between Chinese and English. */
  onLanguage(): void;
}

/** The sidebar: the workspace's pages, then the conversations, like a session list. Folds to a rail of icons. */
export function Nav({ state, pages, page, mode, selected, session, onSession, connection, onPage, onSelect, onFold, onPalette, onConversations, sheet, onLanguage }: NavProps) {
  const scheme = useScheme();
  const other = scheme === "dark" ? "light" : "dark";
  const rename = (conversation: Conversation) => {
    const title = window.prompt(t("nav.rename"), conversation.title);
    if (title && title.trim() && title.trim() !== conversation.title) api.updateConversation(conversation.id, { title }).catch(() => {});
  };
  const archive = (conversation: Conversation) => {
    api.updateConversation(conversation.id, { archived: true }).then(() => { if (selected === conversation.id) onSelect(null); }).catch(() => {});
  };
  // Everyday conversations here; development sessions are listed under their projects in the Code group.
  const daily = state.conversations.filter((conversation) => !conversation.projectId);
  const waiting = daily.reduce((sum, conversation) => sum + conversation.attention, 0);
  const groups: Array<[string, PageDef[]]> = [
    [t("nav.g.work"), pages.filter((item) => item.group === "work")], [t("nav.g.modules"), pages.filter((item) => item.group === "modules")],
    [t("nav.g.dev"), pages.filter((item) => item.group === "dev")], [t("nav.g.system"), pages.filter((item) => item.group === "system")],
  ];
  const projects = (state.projects ?? []).filter((project) => project.trustedAt);
  const sessionsIn = (projectId: string) => state.conversations.filter((conversation) => conversation.projectId === projectId).slice(0, 4);

  return (
    <nav className="nav" data-mode={mode} aria-label={t("nav.label")}>
      <div className="nav-top">
        <button type="button" className="find" onClick={onPalette} title={t("nav.findTitle", { key: `${MOD}K` })}>
          <Icon name="search" /><span>{t("nav.find")}</span><kbd>{MOD}K</kbd>
        </button>
        {sheet ? (
          <button type="button" className="icon-btn" onClick={onFold} aria-label={t("common.close")} title={t("common.close")}><Icon name="close" /></button>
        ) : (
          <button type="button" className="icon-btn" onClick={onFold} aria-label={t(mode === "full" ? "nav.fold" : "nav.unfold")} title={`${t(mode === "full" ? "nav.fold" : "nav.unfold")} (${MOD}\\)`}>
            <Icon name="rail" />
          </button>
        )}
      </div>

      {groups.map(([label, items]) => items.length > 0 && (
        <div className="nav-group" key={label}>
          <p className="nav-label">{label}</p>
          {items.map((item) => {
            const count = item.badge?.(state.modules[moduleOf(item)], state);
            return (
              <button type="button" key={item.key} className="nav-item" data-k={item.k} aria-current={page === item.key ? "page" : undefined}
                onClick={() => onPage(item.key)} title={mode === "rail" ? item.title : undefined}>
                <Icon name={item.icon} /><span className="label">{item.title}</span>
                {count ? <span className="count">{count}</span> : null}
              </button>
            );
          })}
          {items.some((item) => item.group === "dev") && mode === "full" && projects.map((project) => (
            <div className="nav-project" key={project.id}>
              <p className="nav-project-name" title={project.path}>{project.name}</p>
              <ul className="conv-list">
                {sessionsIn(project.id).map((conversation) => (
                  <li key={conversation.id}>
                    <button type="button" className="conv" aria-current={session === conversation.id ? "true" : undefined}
                      onClick={() => onSession(conversation.id)} title={conversation.lastGoal ?? conversation.title}>
                      <span className="st" aria-hidden="true">
                        {conversation.attention > 0 ? <span className="mark" data-k="warm" /> : conversation.busy > 0 ? <span className="pulse" /> : <span className="mark dim" />}
                      </span>
                      <span className="ct">{conversation.title}</span>
                      <span className="time">{when(conversation.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}

      <div className="nav-spacer" />

      <div className="conv-head">
        <span>{t("nav.conversations")}</span>
        <button type="button" className="icon-btn" aria-label={t("nav.newConversation")} title={t("nav.newConversation")} onClick={() => onSelect(null)}><Icon name="plus" /></button>
      </div>
      <ul className="conv-list">
        {daily.length === 0 && <li className="quiet small empty-list">{t("nav.noConversations")}</li>}
        {daily.map((conversation) => (
          <li key={conversation.id}>
            <button type="button" className="conv" aria-current={selected === conversation.id ? "true" : undefined}
              onClick={() => onSelect(conversation.id)} onDoubleClick={() => rename(conversation)} title={conversation.lastGoal ?? conversation.title}>
              <span className="st" aria-hidden="true">
                {conversation.attention > 0 ? <span className="mark" data-k="warm" /> : conversation.busy > 0 ? <span className="pulse" /> : <span className="mark dim" />}
              </span>
              <span className="ct">{conversation.title}</span>
              {conversation.attention > 0
                ? <span className="badge attention" aria-label={t("nav.attention", { n: conversation.attention })}>{conversation.attention}</span>
                : <span className="time">{when(conversation.updatedAt)}</span>}
            </button>
            <button type="button" className="archive" aria-label={t("nav.archive", { title: conversation.title })} onClick={() => archive(conversation)}>
              <Icon name="archive" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="nav-item conv-rail" onClick={onConversations} title={t("nav.conversations")} aria-label={t("nav.conversations")}>
        <Icon name="chat" />{waiting ? <span className="count">{waiting}</span> : null}
      </button>

      <div className="nav-foot">
        <p className="connection" data-state={connection} title={t(CONNECTION[connection])}><span aria-hidden="true" /><b>{t(CONNECTION[connection])}</b></p>
        <span className="nav-foot-end">
          <button type="button" className="icon-btn scheme" onClick={(event) => setAppearance(other, origin(event))}
            aria-label={t(`scheme.to.${other}`)} title={t(`scheme.to.${other}`)}>
            <Icon name={other === "dark" ? "moon" : "sun"} />
          </button>
          <button type="button" className="lang" onClick={onLanguage} title={t("nav.languageTitle")} lang={getLocale() === "zh" ? "en" : "zh"}>{t("nav.language")}</button>
        </span>
      </div>
    </nav>
  );
}
