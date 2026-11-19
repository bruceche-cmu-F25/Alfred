import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Conversation } from "@alfred/protocol";
import { Icon, type IconName } from "./icons.tsx";
import type { PageDef } from "./pages.tsx";

interface Item { id: string; label: string; icon: IconName; hint?: string; run(): void }

export interface PaletteProps {
  pages: PageDef[];
  conversations: Conversation[];
  /** Extra commands, e.g. "new conversation", "close Alfred". */
  actions: Array<{ id: string; label: string; icon: IconName; hint?: string; run(): void }>;
  onPage(key: string): void;
  onSelect(id: string): void;
  /** Ask Alfred in words: the text becomes a message in the open conversation (or a new one). */
  onAsk(text: string): void;
  onClose(): void;
}

/** ⌘K: go anywhere, run a command, or just say it to Alfred. */
export function Palette({ pages, conversations, actions, onPage, onSelect, onAsk, onClose }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    const list: Item[] = [
      ...pages.filter((page) => match(page.title)).map((page, n) => ({ id: `page:${page.key}`, label: `去「${page.title}」`, icon: page.icon, hint: n < 9 ? `⌥${n + 1}` : undefined, run: () => onPage(page.key) })),
      ...actions.filter((action) => match(action.label)),
      ...conversations.filter((conversation) => match(conversation.title)).slice(0, q ? 8 : 5)
        .map((conversation) => ({ id: `conv:${conversation.id}`, label: conversation.title, icon: "chat" as const, hint: "对话", run: () => onSelect(conversation.id) })),
    ];
    if (q) {
      const ask: Item = { id: "ask", label: `问 Alfred：${query.trim()}`, icon: "chat", hint: "↵", run: () => onAsk(query.trim()) };
      // Saying it is the default when nothing else matches.
      return list.length ? [...list, ask] : [ask];
    }
    return list;
  }, [query, pages, actions, conversations, onPage, onSelect, onAsk]);

  useEffect(() => { setIndex(0); }, [query]);

  const choose = (item: Item | undefined) => { if (!item) return; onClose(); item.run(); };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex((current) => Math.min(items.length - 1, current + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setIndex((current) => Math.max(0, current - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(items[index]); }
    else if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };

  return (
    <div className="palette" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="搜索或问 Alfred">
        <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKey}
          placeholder="去哪一页、打开哪条对话，或者直接跟 Alfred 说…" aria-label="搜索或问 Alfred"
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[index] ? `pal-${index}` : undefined} />
        <ul id="palette-list" role="listbox">
          {items.map((item, n) => (
            <li key={item.id}>
              <button type="button" id={`pal-${n}`} role="option" aria-selected={n === index} onMouseMove={() => setIndex(n)} onClick={() => choose(item)}>
                <Icon name={item.icon} /><span>{item.label}</span>{item.hint && <kbd>{item.hint}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
