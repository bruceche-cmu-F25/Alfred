/** The workspace's pages. A module's page is one of its views: the home node says which exist (StateResponse.views),
 * this registry says how to draw them, and the page gets only its own module's snapshot and the shared helpers.
 * Core pages (`core.*`: the inbox, later automations) belong to the shell and read the core's state.
 */
import type { ReactNode } from "react";
import type { Area, StateResponse, ViewContext } from "@alfred/protocol";
import type { TodoSnapshot } from "@alfred/module-todo/types";
import { Automations } from "../Automations.tsx";
import { automationTitle, whenText } from "../automationText.ts";
import { Dev, sessionsOf, type DevProps } from "../Dev.tsx";
import { Inbox } from "../Inbox.tsx";
import { Settings } from "../Settings.tsx";
import { Todos } from "../Todos.tsx";
import { t, type Key } from "../i18n/index.ts";
import { inboxItems, waitingCount } from "./inbox.ts";
import type { IconName } from "./icons.tsx";

export interface PageProps {
  snapshot: unknown;
  /** Subjects (like `todo:abc`) Alfred changed in the last few seconds. */
  fresh: ReadonlySet<string>;
  /** The shared areas of life (core's kernel), for pages that sort by them. */
  areas: Area[];
  /** Core pages only: the whole state, and ways to reach the rest of the workspace. */
  state: StateResponse;
  focus: string | null;
  onFocused(): void;
  openConversation(conversationId: string, runId?: string): void;
  /** The Code page: its open session and what a conversation needs. */
  dev: Omit<DevProps, "state">;
}

export interface PageDef {
  /** `<module>.<view>`, as the home node names the view. */
  key: string;
  title: string;
  icon: IconName;
  /** Category colour slot (tokens.css `data-k`). */
  k: string;
  /** Sidebar group: the daily workspace, the other modules, coding, or the app itself (settings). */
  group: "work" | "modules" | "dev" | "system";
  /** The page draws its own top (no title and summary above it), and Alfred's panel steps aside for it. */
  bare?: boolean;
  /** A number for the sidebar, or nothing. */
  badge?(snapshot: unknown, state: StateResponse): number | undefined;
  /** One plain line under the page title: the facts. It also tells Alfred what you were looking at when you ask. */
  summary?(snapshot: unknown, state: StateResponse): string;
  /** Alfred's own line about the page, in its voice, shown under its name while nothing is going on. */
  headline?(snapshot: unknown, state: StateResponse): string;
  /** Questions worth asking from this page, most useful first; the chips above the composer. */
  suggestions?(snapshot: unknown, state: StateResponse): Key[];
  render(props: PageProps): ReactNode;
}

/** The automation that fires next, if any is on. */
function soonest(state: StateResponse) {
  return (state.automations ?? []).filter((automation) => automation.enabled && automation.nextAt).sort((a, b) => a.nextAt!.localeCompare(b.nextAt!))[0];
}

/** Counts the todo page and its lines share. A range running today counts as due today. */
function todoCounts(snapshot: unknown) {
  const { todos = [], today = "" } = (snapshot as TodoSnapshot | undefined) ?? {};
  const open = todos.filter((todo) => !todo.done);
  const runsToday = (todo: (typeof open)[number]) => !!todo.due && (todo.due === today || (!!todo.startDate && todo.startDate <= today && todo.due >= today));
  return {
    open: open.length,
    late: open.filter((todo) => !!todo.due && todo.due < today && !runsToday(todo)).length,
    today: open.filter(runsToday).length,
  };
}

const PAGES: PageDef[] = [
  {
    key: "core.inbox", get title() { return t("page.inbox"); }, icon: "inbox", k: "warm", group: "work",
    badge: (_, state) => waitingCount(state),
    summary: (_, state) => {
      const waiting = waitingCount(state), rest = inboxItems(state).length - waiting;
      if (!waiting && !rest) return t("page.inbox.clear");
      return waiting ? t("page.inbox.waiting", { n: waiting }) + (rest ? t("page.inbox.rest", { n: rest }) : "") : t("page.inbox.onlyRest", { n: rest });
    },
    headline: (_, state) => {
      const waiting = waitingCount(state), rest = inboxItems(state).length - waiting;
      if (waiting) return t("head.inbox.waiting", { n: waiting });
      return rest ? t("head.inbox.results", { n: rest }) : t("head.inbox.clear");
    },
    suggestions: (_, state) => {
      const waiting = waitingCount(state), any = inboxItems(state).length > 0;
      return waiting ? ["sug.inbox.urgent", "sug.inbox.what"] : any ? ["sug.inbox.what"] : ["sug.inbox.today"];
    },
    render: ({ state, focus, onFocused, openConversation }) => <Inbox state={state} focus={focus} onFocused={onFocused} onOpenConversation={openConversation} />,
  },
  {
    key: "todo.list", get title() { return t("page.todos"); }, icon: "todo", k: "blue", group: "work",
    badge: (snapshot) => (snapshot as TodoSnapshot | undefined)?.todos.filter((todo) => !todo.done).length,
    summary: (snapshot) => {
      const { open, late } = todoCounts(snapshot);
      return open ? t("page.todos.open", { n: open }) + (late ? t("page.todos.late", { n: late }) : "") : t("page.todos.allDone");
    },
    headline: (snapshot) => {
      const { open, late, today } = todoCounts(snapshot);
      if (late) return today ? t("head.todos.late", { late, today }) : t("head.todos.lateOnly", { late });
      if (today) return t("head.todos.today", { today });
      return open ? t("head.todos.open", { n: open }) : t("head.todos.clear");
    },
    suggestions: (snapshot) => {
      const { open, late } = todoCounts(snapshot);
      if (!open) return [];
      return late ? ["sug.todos.first", "sug.todos.late", "sug.todos.week"] : ["sug.todos.first", "sug.todos.week"];
    },
    render: ({ snapshot, fresh, areas }) => <Todos snapshot={snapshot as TodoSnapshot} fresh={fresh} areas={areas} />,
  },
  {
    key: "core.automations", get title() { return t("page.automations"); }, icon: "clock", k: "green", group: "modules",
    summary: (_, state) => {
      const all = state.automations ?? [], next = soonest(state);
      if (!all.length) return t("auto.sum.empty");
      return next ? t("auto.sum.next", { on: all.filter((automation) => automation.enabled).length, when: whenText(next.nextAt!) }) : t("auto.sum.off", { n: all.length });
    },
    headline: (_, state) => {
      const next = soonest(state);
      if (!state.automations?.length) return t("head.auto.empty");
      return next ? t("head.auto.next", { name: automationTitle(next), when: whenText(next.nextAt!) }) : t("head.auto.off");
    },
    suggestions: (_, state) => [
      ...(state.automations?.some((automation) => automation.template === "brief") ? ["sug.auto.brief" as const] : []),
      "sug.auto.weekly", "sug.auto.which",
    ],
    render: ({ state, openConversation }) => <Automations state={state} onOpenConversation={openConversation} />,
  },
  {
    key: "core.dev", get title() { return t("page.dev"); }, icon: "code", k: "violet", group: "dev", bare: true,
    badge: (_, state) => sessionsOf(state).reduce((sum, conversation) => sum + conversation.attention, 0) || undefined,
    summary: (_, state) => state.projects?.length ? t("page.dev.summary", { n: state.projects.length }) : t("page.dev.none"),
    render: ({ state, dev }) => <Dev state={state} {...dev} />,
  },
  {
    key: "core.settings", get title() { return t("page.settings"); }, icon: "gear", k: "gray", group: "system",
    summary: () => t("page.settings.summary"),
    render: () => <Settings />,
  },
];

/** The pages this home node actually has, in registry order: the core's, then each module view it offers. */
export function availablePages(state: StateResponse): PageDef[] {
  const offered = new Set(Object.entries(state.views).flatMap(([module, views]) => views.map((view) => `${module}.${view.id}`)));
  return PAGES.filter((page) => page.key.startsWith("core.") || offered.has(page.key));
}

export const moduleOf = (page: PageDef) => page.key.split(".")[0];

/** The page as Alfred hears about it with a question: which page, its title and its facts. Context, not a request. */
export interface PageView {
  context: ViewContext;
  title: string;
  headline?: string;
  suggestions: string[];
}
export function pageView(page: PageDef | undefined, state: StateResponse): PageView | undefined {
  if (!page) return undefined;
  const snapshot = state.modules[moduleOf(page)];
  const summary = page.summary?.(snapshot, state);
  return {
    context: { view: page.key, title: page.title, ...(summary ? { summary } : {}) },
    title: page.title,
    headline: page.headline?.(snapshot, state),
    suggestions: (page.suggestions?.(snapshot, state) ?? []).map((key) => t(key)),
  };
}
