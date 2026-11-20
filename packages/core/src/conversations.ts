/** A conversation: one thread about one topic. Text, voice and clicks write
 * into it; its runs keep their order inside it, while different conversations
 * proceed side by side. It is not an engine session: engines come and go,
 * the conversation stays.
 */
import type { DatabaseSync } from "node:sqlite";
import { appendEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import { getProject, ProjectError, SESSION_MODES, type SessionMode } from "./projects.ts";
import type { World } from "./world.ts";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** `provider/model` this conversation uses; null for the engine's default. */
  model: string | null;
  /** How hard the model thinks; null for the default. */
  thinking: ThinkingLevel | null;
  /** Runs queued or in progress. */
  busy: number;
  /** Runs that need the user: a question waiting, or interrupted. */
  attention: number;
  /** The newest request in it, for a list preview. */
  lastGoal: string | null;
  /** The project it works in (a development session); null for an everyday conversation. Fixed at creation. */
  projectId: string | null;
  /** A development session's permission mode; null for an everyday conversation. */
  mode: SessionMode | null;
  /** The commit a development session's changes are measured against; null when its folder is not a git repository. */
  base: string | null;
  /** The commands the user allowed for the rest of a development session (shell.ts). */
  commands: string[];
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
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const MODEL = /^[A-Za-z0-9._-]{1,60}\/[A-Za-z0-9._:@\/-]{1,139}$/;

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
    archivedAt: row.archived_at as string | null, model: row.model as string | null, thinking: row.thinking as ThinkingLevel | null,
    busy: row.busy as number, attention: row.attention as number,
    lastGoal: row.last_goal ? String(row.last_goal).slice(0, 120) : null,
    projectId: (row.project_id as string | null) ?? null,
    mode: (row.mode as SessionMode | null) ?? null,
    base: (row.base as string | null) ?? null,
    commands: (JSON.parse((row.commands as string | undefined) ?? "[]") as Array<{ command: string }>).map((grant) => grant.command),
  };
}

/** Only inside a world transaction. */
export function createConversation(db: DatabaseSync, input: { title: string; now: number; projectId?: string; mode?: SessionMode; base?: string | null }): string {
  const id = newId();
  db.prepare("INSERT INTO core_conversations (id, title, created_at, updated_at, project_id, mode, base) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.title.slice(0, 200), iso(input.now), iso(input.now), input.projectId ?? null, input.projectId ? input.mode ?? "ask" : null, input.base ?? null);
  appendEvent(db, {
    kind: "conversation.created", subject: `conversation:${id}`, runId: null, now: input.now,
    payload: { title: input.title.slice(0, 200), ...(input.projectId ? { projectId: input.projectId } : {}) },
  });
  return id;
}

/** A development session in a trusted project, created before its first message (an everyday conversation is
 * created by its first message instead). The title comes from what the user is about to ask. */
export function startSession(world: World, input: { projectId: string; title: string; mode?: SessionMode; base?: string | null; now?: number }): Conversation {
  const now = input.now ?? Date.now();
  const project = getProject(world, input.projectId);
  if (!project.trustedAt) throw new ProjectError("untrusted");
  if (input.mode !== undefined && !SESSION_MODES.includes(input.mode)) throw new ConversationError("invalid", "Unknown permission mode");
  if (input.base !== undefined && input.base !== null && !/^[0-9a-f]{4,64}$/.test(input.base)) throw new ConversationError("invalid", "A base is a commit id");
  const id = world.tx((db) => createConversation(db, { title: titleFrom(input.title), now, projectId: project.id, mode: input.mode, base: input.base }));
  return getConversation(world, id);
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

export function updateConversation(
  world: World,
  id: string,
  change: { title?: string; archived?: boolean; model?: string | null; thinking?: ThinkingLevel | null; mode?: SessionMode; now?: number },
): Conversation {
  const now = change.now ?? Date.now();
  if (change.model !== undefined && change.model !== null && !MODEL.test(change.model)) throw new ConversationError("invalid", "A model is written provider/model");
  if (change.thinking !== undefined && change.thinking !== null && !THINKING_LEVELS.includes(change.thinking)) throw new ConversationError("invalid", "Unknown thinking level");
  world.tx((db) => {
    const row = db.prepare("SELECT title, archived_at, model, thinking, project_id, mode FROM core_conversations WHERE id = ?").get(id);
    if (!row) throw new ConversationError("missing");
    if (change.mode !== undefined && change.mode !== row.mode) {
      if (!row.project_id) throw new ConversationError("invalid", "Only a development session has a permission mode");
      if (!SESSION_MODES.includes(change.mode)) throw new ConversationError("invalid", "Unknown permission mode");
      db.prepare("UPDATE core_conversations SET mode = ? WHERE id = ?").run(change.mode, id);
      appendEvent(db, { kind: "conversation.mode_set", subject: `conversation:${id}`, payload: { from: row.mode ?? null, to: change.mode }, runId: null, now });
    }
    for (const field of ["model", "thinking"] as const) {
      const value = change[field];
      if (value === undefined || value === row[field]) continue;
      db.prepare(`UPDATE core_conversations SET ${field} = ? WHERE id = ?`).run(value, id);
      appendEvent(db, { kind: `conversation.${field}_set`, subject: `conversation:${id}`, payload: { from: row[field] ?? null, to: value }, runId: null, now });
    }
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
