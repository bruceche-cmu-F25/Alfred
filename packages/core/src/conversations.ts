/** A conversation: one thread about one topic. Text, voice and clicks write
 * into it; its runs keep their order inside it, while different conversations
 * proceed side by side. It is not an engine session: engines come and go,
 * the conversation stays.
 */
import type { DatabaseSync } from "node:sqlite";
import { appendEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import type { World } from "./world.ts";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Runs queued or in progress. */
  busy: number;
  /** Runs that need the user: a question waiting, or interrupted. */
  attention: number;
  /** The newest request in it, for a list preview. */
  lastGoal: string | null;
}

export class ConversationError extends Error {
  override name = "ConversationError";
  readonly code: "missing" | "invalid";
  constructor(code: "missing" | "invalid", message?: string) {
    super(message ?? (code === "missing" ? "No such conversation" : "Invalid conversation"));
    this.code = code;
  }
}

export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A title from what the user first asked: the start of it, on one line. */
export function titleFrom(goal: string): string {
  const line = goal.replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line || "新对话";
}

const SELECT = `SELECT c.*,
  (SELECT count(*) FROM core_runs r WHERE r.conversation_id = c.id AND r.state IN ('queued', 'running', 'cancelling')) AS busy,
  (SELECT count(*) FROM core_runs r WHERE r.conversation_id = c.id AND r.state IN ('waiting_input', 'waiting_permission', 'interrupted')) AS attention,
  (SELECT r.goal FROM core_runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS last_goal
  FROM core_conversations c`;

function toConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string, title: row.title as string, createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | null, busy: row.busy as number, attention: row.attention as number,
    lastGoal: row.last_goal ? String(row.last_goal).slice(0, 120) : null,
  };
}

/** Only inside a world transaction. */
export function createConversation(db: DatabaseSync, input: { title: string; now: number }): string {
  const id = newId();
  db.prepare("INSERT INTO core_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, input.title.slice(0, 200), iso(input.now), iso(input.now));
  appendEvent(db, { kind: "conversation.created", subject: `conversation:${id}`, payload: { title: input.title.slice(0, 200) }, runId: null, now: input.now });
  return id;
}

/** Only inside a world transaction: the conversation exists and has just been active. */
export function touchConversation(db: DatabaseSync, id: string, now: number): void {
  const changed = db.prepare("UPDATE core_conversations SET updated_at = ? WHERE id = ?").run(iso(now), id);
  if (changed.changes === 0) throw new ConversationError("missing");
}

export function getConversation(world: World, id: string): Conversation {
  const row = world.db.prepare(`${SELECT} WHERE c.id = ?`).get(id);
  if (!row) throw new ConversationError("missing");
  return toConversation(row);
}

/** Most recently active first. */
export function listConversations(world: World, options: { includeArchived?: boolean; limit?: number } = {}): Conversation[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  return world.db.prepare(`${SELECT} WHERE (? = 1 OR c.archived_at IS NULL) ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`)
    .all(options.includeArchived ? 1 : 0, limit).map(toConversation);
}

export function updateConversation(world: World, id: string, change: { title?: string; archived?: boolean; now?: number }): Conversation {
  const now = change.now ?? Date.now();
  world.tx((db) => {
    const row = db.prepare("SELECT title, archived_at FROM core_conversations WHERE id = ?").get(id);
    if (!row) throw new ConversationError("missing");
    if (change.title !== undefined) {
      const title = change.title.replace(/\s+/g, " ").trim();
      if (!title || title.length > 200) throw new ConversationError("invalid", "A title is 1–200 characters");
      if (title !== row.title) {
        db.prepare("UPDATE core_conversations SET title = ? WHERE id = ?").run(title, id);
        appendEvent(db, { kind: "conversation.renamed", subject: `conversation:${id}`, payload: { from: row.title, to: title }, runId: null, now });
      }
    }
    if (change.archived !== undefined && change.archived !== (row.archived_at !== null)) {
      db.prepare("UPDATE core_conversations SET archived_at = ? WHERE id = ?").run(change.archived ? iso(now) : null, id);
      appendEvent(db, { kind: change.archived ? "conversation.archived" : "conversation.restored", subject: `conversation:${id}`, payload: {}, runId: null, now });
    }
  });
  return getConversation(world, id);
}
