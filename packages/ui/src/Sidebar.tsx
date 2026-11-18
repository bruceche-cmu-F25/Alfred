import type { Conversation } from "@alfred/protocol";
import { api, type Connection } from "./api.ts";

const CONNECTION = { connecting: "连接中", live: "在线", reconnecting: "重新连接中" } as const;

export interface Place { module: string; view: string; title: string; count?: number }

export interface SidebarProps {
  conversations: Conversation[];
  selected: string | null;
  places: Place[];
  openPlace: string | null;
  connection: Connection;
  onSelect(id: string | null): void;
  onPlace(place: Place): void;
}

/** Like a session list: every conversation, and which ones are busy or need you. */
export function Sidebar({ conversations, selected, places, openPlace, connection, onSelect, onPlace }: SidebarProps) {
  const rename = (conversation: Conversation) => {
    const title = window.prompt("对话名称", conversation.title);
    if (title && title.trim() && title.trim() !== conversation.title) api.updateConversation(conversation.id, { title }).catch(() => {});
  };
  const archive = (conversation: Conversation) => {
    api.updateConversation(conversation.id, { archived: true }).then(() => { if (selected === conversation.id) onSelect(null); }).catch(() => {});
  };
  return (
    <nav className="sidebar" aria-label="对话和模块">
      <div className="sidebar-head">
        <p className="wordmark">Alfred</p>
        <p className="connection" data-state={connection}><span aria-hidden="true" />{CONNECTION[connection]}</p>
      </div>
      <button type="button" className="new-conversation" aria-pressed={selected === null} onClick={() => onSelect(null)}>＋ 新对话</button>
      {places.length > 0 && (
        <ul className="places" aria-label="模块">
          {places.map((place) => {
            const key = `${place.module}.${place.view}`;
            return (
              <li key={key}>
                <button type="button" aria-pressed={openPlace === key} onClick={() => onPlace(place)}>
                  {place.title}{place.count !== undefined && <span className="count">{place.count}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="sidebar-label">对话</p>
      <ul className="conversations">
        {conversations.length === 0 && <li className="quiet small empty-list">还没有对话。</li>}
        {conversations.map((conversation) => (
          <li key={conversation.id} data-current={selected === conversation.id || undefined}>
            <button type="button" className="conversation-link" aria-current={selected === conversation.id ? "page" : undefined}
              onClick={() => onSelect(conversation.id)} onDoubleClick={() => rename(conversation)} title={conversation.lastGoal ?? conversation.title}>
              <span className="conversation-title">{conversation.title}</span>
              {conversation.attention > 0 && <span className="badge attention" aria-label={`${conversation.attention} 件需要你`}>{conversation.attention}</span>}
              {conversation.attention === 0 && conversation.busy > 0 && <span className="pulse" aria-label="在办" />}
            </button>
            <button type="button" className="archive" aria-label={`归档「${conversation.title}」`} onClick={() => archive(conversation)}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M5 6v9h10V6M8 9h4" /></svg>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
