/** What typing can go to, in the ask bar and in ⌘K's palette: a page, a command, a conversation. One list for both,
 * so searching is the same wherever it is done. */
import type { Conversation } from "@alfred/protocol";
import { t } from "../i18n/dict.ts";
import type { IconName } from "./icons.tsx";

export interface FindCommand { id: string; label: string; icon: IconName; hint?: string; run(): void }
export interface FindItem extends FindCommand { unread?: boolean; kind: "page" | "command" | "conversation" }
export interface FindSources {
  pages: ReadonlyArray<{ key: string; title: string; icon: IconName }>;
  /** Extra commands, e.g. "new conversation", "close Alfred". */
  commands: readonly FindCommand[];
  conversations: ReadonlyArray<Pick<Conversation, "id" | "title" | "unreadReplyId" | "briefOnly">>;
  onPage(key: string): void;
  onSelect(id: string): void;
}

/** Everything whose name contains the words, pages first, then commands, then conversations (the newest few). With
 * no words: all pages and commands, and the last conversations. */
export function findItems(query: string, { pages, commands, conversations, onPage, onSelect }: FindSources): FindItem[] {
  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  return [
    ...pages.filter((page) => match(page.title)).map((page, n) => ({
      kind: "page" as const, id: `page:${page.key}`, label: t("pal.go", { title: page.title }), icon: page.icon, hint: n < 9 ? `⌥${n + 1}` : undefined, run: () => onPage(page.key),
    })),
    ...commands.filter((command) => match(command.label)).map((command) => ({ ...command, kind: "command" as const })),
    ...conversations.filter((conversation) => !conversation.briefOnly && match(conversation.title)).slice(0, q ? 8 : 5).map((conversation) => ({
      kind: "conversation" as const, id: `conv:${conversation.id}`, label: conversation.title, unread: !!conversation.unreadReplyId, icon: "chat" as const, hint: t("pal.conversation"), run: () => onSelect(conversation.id),
    })),
  ];
}

/** In the ask bar, what Enter does with the words when nothing was picked by hand: it goes to the first page or
 * command whose name contains all of them, and otherwise says them to Alfred (-1). A conversation is never the
 * default: its title is usually a question once asked, and asking that again must not open the old one instead. */
export function defaultPick(items: readonly FindItem[]): number {
  return items.findIndex((item) => item.kind !== "conversation");
}
