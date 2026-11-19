import { t } from "../i18n/index.ts";
import { Icon, type IconName } from "./icons.tsx";
import { MOD, ViewButtons } from "./Nav.tsx";
import type { PageDef } from "./pages.tsx";

export type Mode = "daily" | "dev";
const MODE_ICON: Record<Mode, IconName> = { daily: "home", dev: "code" };

export interface TopbarProps {
  navOpen: boolean;
  onNav(): void;
  mode: Mode;
  /** Absent when this device has no Code page: then there is nothing to switch. */
  onMode?: (mode: Mode) => void;
  onLanguage(): void;
  /** The page in view: its name is the bar's title, its facts the quiet line beside it. Absent when no page is in sight. */
  heading?: { title: string; icon: IconName; k: string; summary?: string };
  /** The app's own pages (Settings), as buttons at the right. */
  system: PageDef[];
  page: string;
  onPage(key: string): void;
}

/**
 * The bar across the top of the window, in two parts divided by the line that runs on down the sidebar's edge.
 * The lead is as wide as the sidebar under it: in the Mac app the window buttons, then the sidebar button, and the
 * switch between the daily workspace and Code at its right end. The switch belongs with the sidebar it changes, so
 * it goes away with it: while the sidebar is folded the lead is only the sidebar button. The rest is the page's: its name and its facts,
 * so the page under the bar starts with its contents; at the far right, light/dark, the language and Settings.
 * The bar drags the window.
 */
export function Topbar({ navOpen, onNav, mode, onMode, onLanguage, heading, system, page, onPage }: TopbarProps) {
  const fold = t(navOpen ? "nav.fold" : "nav.unfold");
  return (
    <header className="topbar">
      <div className="topbar-lead">
        <button type="button" className="icon-btn" onClick={onNav} aria-label={fold} aria-pressed={navOpen} title={`${fold} (${MOD}\\)`}>
          <Icon name="rail" />
        </button>
        {onMode && navOpen && (
          <div className="mode-switch" role="group" aria-label={t("top.mode")}>
            {(["daily", "dev"] as const).map((id) => (
              <button type="button" key={id} aria-pressed={mode === id} aria-label={t(`top.${id}`)} title={t(`top.${id}`)} onClick={() => onMode(id)}>
                <Icon name={MODE_ICON[id]} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="topbar-main">
        {heading && <h1 className="topbar-title" data-k={heading.k}><Icon name={heading.icon} /><span>{heading.title}</span></h1>}
        {heading?.summary && <p className="topbar-sub">{heading.summary}</p>}
        <div className="topbar-room" />
        <ViewButtons onLanguage={onLanguage} />
        {system.map((item) => (
          <button type="button" key={item.key} className="icon-btn" onClick={() => onPage(item.key)} aria-label={item.title} title={item.title}
            aria-current={page === item.key ? "page" : undefined}>
            <Icon name={item.icon} />
          </button>
        ))}
      </div>
    </header>
  );
}
