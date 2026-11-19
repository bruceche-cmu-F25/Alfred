/** The workspace's pages. A module's page is one of its views: the home node says which exist (StateResponse.views),
 * this registry says how to draw them, and the page gets only its own module's snapshot and the shared helpers.
 * Core pages (`core.*`: the inbox, later automations) belong to the shell and read the core's state.
 */
import type { ReactNode } from "react";
import type { Area, StateResponse } from "@alfred/protocol";
import type { TodoSnapshot } from "@alfred/module-todo/types";
import { Inbox } from "../Inbox.tsx";
import { Todos } from "../Todos.tsx";
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
}

export interface PageDef {
  /** `<module>.<view>`, as the home node names the view. */
  key: string;
  title: string;
  icon: IconName;
  /** Category colour slot (tokens.css `data-k`). */
  k: string;
  /** Sidebar group: the daily workspace, or the other modules. */
  group: "work" | "modules";
  /** A number for the sidebar, or nothing. */
  badge?(snapshot: unknown, state: StateResponse): number | undefined;
  /** One plain line under the page title. */
  summary?(snapshot: unknown, state: StateResponse): string;
  render(props: PageProps): ReactNode;
}

const PAGES: PageDef[] = [
  {
    key: "core.inbox", title: "通知", icon: "inbox", k: "warm", group: "work",
    badge: (_, state) => waitingCount(state),
    summary: (_, state) => {
      const waiting = waitingCount(state), rest = inboxItems(state).length - waiting;
      if (!waiting && !rest) return "都处理完了";
      return waiting ? `${waiting} 件等你决定${rest ? `，其余 ${rest} 件是 Alfred 告诉你一声` : ""}` : `${rest} 件 Alfred 告诉你一声`;
    },
    render: ({ state, focus, onFocused, openConversation }) => <Inbox state={state} focus={focus} onFocused={onFocused} onOpenConversation={openConversation} />,
  },
  {
    key: "todo.list", title: "待办", icon: "todo", k: "blue", group: "work",
    badge: (snapshot) => (snapshot as TodoSnapshot | undefined)?.todos.filter((todo) => !todo.done).length,
    summary: (snapshot) => {
      const todos = (snapshot as TodoSnapshot | undefined)?.todos ?? [];
      const today = (snapshot as TodoSnapshot | undefined)?.today ?? "";
      const open = todos.filter((todo) => !todo.done);
      const late = open.filter((todo) => todo.due && todo.due < today).length;
      return open.length ? `${open.length} 件没做完${late ? `，${late} 件逾期` : ""}` : "都做完了";
    },
    render: ({ snapshot, fresh, areas }) => <Todos snapshot={snapshot as TodoSnapshot} fresh={fresh} areas={areas} />,
  },
];

/** The pages this home node actually has, in registry order: the core's, then each module view it offers. */
export function availablePages(state: StateResponse): PageDef[] {
  const offered = new Set(Object.entries(state.views).flatMap(([module, views]) => views.map((view) => `${module}.${view.id}`)));
  return PAGES.filter((page) => page.key.startsWith("core.") || offered.has(page.key));
}

export const moduleOf = (page: PageDef) => page.key.split(".")[0];
