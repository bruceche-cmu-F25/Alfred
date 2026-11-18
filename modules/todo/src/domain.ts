/** Todo rules, shared by device commands and agent tools. Ported from Robin's
 * todo-domain.ts. A todo is stored whole as JSON, so fields this version does
 * not edit yet (colour, estimate, work plan…) survive an import untouched.
 */
import { createHash } from "node:crypto";
import { changedFields, localDate, newId, recordDomainEvent, type World } from "@alfred/core";
import { TODO_STATUSES, type Todo, type TodoStatus } from "./types.ts";

export { TODO_STATUSES, type Todo, type TodoStatus };

export interface TodoRef { id?: string; title?: string; revision?: string }
export interface TodoPatch {
  done?: boolean;
  status?: TodoStatus;
  title?: string;
  /** Empty string clears it. */
  startDate?: string;
  /** Empty string clears it. */
  due?: string;
  /** Empty string clears it; never changes `due`. */
  plannedOn?: string;
  /** Empty string clears it. */
  url?: string;
}
export type TodoResult<T> = T | { error: string };

export class TodoConflictError extends Error {
  override name = "TodoConflictError";
  constructor() { super("Task changed; reload the latest version before saving"); }
}

export const MIGRATIONS = [{
  id: "todo:1",
  sql: `
CREATE TABLE todo_items (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  position INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (
    json_valid(payload) AND json_type(payload) = 'object'
    AND json_extract(payload, '$.id') = id
    AND json_type(payload, '$.title') = 'text'
    AND json_type(payload, '$.done') IN ('true', 'false')
    AND json_type(payload, '$.createdAt') = 'text'
  )
) STRICT;
CREATE INDEX todo_items_position ON todo_items(position);
`,
}];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function localDay(value: string, field: string): string {
  const trimmed = value.trim();
  if (!DATE.test(trimmed)) throw new Error(`${field} must be a local date as YYYY-MM-DD`);
  const [year, month, day] = trimmed.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error(`${field} is not a real date`);
  return trimmed;
}

function normalizeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("url must be an http, https or mailto link"); }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error("url must be an http, https or mailto link");
  return url.href;
}

function readAll(world: World): Todo[] {
  return world.db.prepare("SELECT payload FROM todo_items ORDER BY position").all().map((row) => JSON.parse(row.payload as string) as Todo);
}

function write(world: World, todo: Todo): void {
  world.db.prepare("UPDATE todo_items SET payload = ? WHERE id = ?").run(JSON.stringify(todo), todo.id);
}

/** A version stamp for one todo, so an edit made on a stale copy is refused. */
export function todoRevision(todo: Todo): string {
  return createHash("sha256").update(JSON.stringify(todo)).digest("hex").slice(0, 16);
}

export const todoStatus = (todo: Todo): TodoStatus => todo.done ? "done" : todo.status === "doing" ? "doing" : "todo";
const isOpen = (todo: Todo) => !todo.done && !todo.archivedAt;

/** Reads never delete history; completed and abandoned tasks stay recoverable. */
export function listTodos(world: World, options: { includeDone?: boolean; includeArchived?: boolean } = {}): Todo[] {
  return readAll(world).filter((todo) => (options.includeDone || !todo.done) && (options.includeArchived || !todo.archivedAt));
}

function findTodo(todos: Todo[], ref: TodoRef): TodoResult<Todo> {
  if (ref.id) return todos.find((todo) => todo.id === ref.id) ?? { error: `No todo with id "${ref.id}".` };
  if (!ref.title?.trim()) return { error: "Provide either id or title." };
  const needle = ref.title.trim().toLowerCase();
  const matches = todos.filter((todo) => todo.title.toLowerCase().includes(needle));
  if (matches.length === 0) return { error: `No todo matching "${ref.title}".` };
  if (matches.length > 1) return { error: `"${ref.title}" matches ${matches.length} todos — pass an id. Candidates: ${matches.slice(0, 8).map((todo) => `${todo.id}: ${todo.title}`).join("; ")}` };
  return matches[0];
}

function applyPatch(todo: Todo, patch: TodoPatch): void {
  if (patch.status !== undefined && !TODO_STATUSES.includes(patch.status)) throw new Error("Unknown todo status");
  if (patch.status !== undefined && patch.done !== undefined && (patch.status === "done") !== patch.done) throw new Error("status and done conflict");
  if (patch.status !== undefined || patch.done !== undefined) {
    const status = patch.status ?? (patch.done ? "done" : "todo");
    const done = status === "done";
    if (done && !todo.done) todo.completedAt = new Date().toISOString();
    if (!done) delete todo.completedAt;
    todo.done = done;
    if (done) delete todo.next;
    todo.status = status;
    delete todo.archivedAt;
  }
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("title cannot be empty");
    if (title.length > 500) throw new Error("title is too long");
    todo.title = title;
  }
  if (patch.startDate !== undefined || patch.due !== undefined) {
    const startDate = patch.startDate === undefined ? todo.startDate : patch.startDate.trim() ? localDay(patch.startDate, "startDate") : undefined;
    const due = patch.due === undefined ? todo.due : patch.due.trim() ? localDay(patch.due, "due") : undefined;
    if (startDate && !due) throw new Error("due is required when startDate is set");
    if (startDate && due && startDate > due) throw new Error("startDate cannot be after due");
    // A changed deadline is reviewed on its own merits.
    if (due !== todo.due) delete todo.reviewAfter;
    if (startDate) todo.startDate = startDate; else delete todo.startDate;
    if (due) todo.due = due; else delete todo.due;
  }
  if (patch.plannedOn !== undefined) {
    if (patch.plannedOn.trim()) todo.plannedOn = localDay(patch.plannedOn, "plannedOn"); else delete todo.plannedOn;
  }
  if (patch.url !== undefined) {
    if (patch.url.trim()) todo.url = normalizeUrl(patch.url); else delete todo.url;
  }
}

type TodoOp = "added" | "updated" | "completed" | "deleted";

/** A bounded receipt of what changed, in the same transaction as the change. */
function recordTodoEvent(world: World, op: TodoOp, before: Todo | null, after: Todo | null): void {
  const todo = after ?? before!;
  const changes = before && after ? changedFields(before, after) : undefined;
  if (changes === null) return;
  recordDomainEvent(world, {
    kind: `todo.${op}`,
    subject: `todo:${todo.id}`,
    payload: { todoId: todo.id, title: todo.title.slice(0, 200), ...(changes ? { changes } : {}) },
  });
}

export function addTodo(world: World, input: { title: string } & TodoPatch): { todo: Todo; open: number } {
  if (!input.title?.trim()) throw new Error("title is required");
  const todo: Todo = { id: newId(), title: input.title.trim(), done: false, status: "todo", createdAt: new Date().toISOString() };
  applyPatch(todo, input);
  return world.tx((db) => {
    const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_items").get()!.next as number);
    db.prepare("INSERT INTO todo_items (id, position, payload) VALUES (?, ?, ?)").run(todo.id, position, JSON.stringify(todo));
    recordTodoEvent(world, "added", null, todo);
    return { todo, open: readAll(world).filter(isOpen).length };
  });
}

function changeTodo<T>(world: World, ref: TodoRef, op: TodoOp, change: (todo: Todo) => T): TodoResult<T> {
  return world.tx((db) => {
    const found = findTodo(readAll(world), ref);
    // Todo keeps unknown fields, so test for the field only a todo has.
    if (!("id" in found)) return found;
    if (ref.revision !== undefined && ref.revision !== todoRevision(found)) throw new TodoConflictError();
    const before = structuredClone(found);
    const result = change(found);
    if (op === "deleted") db.prepare("DELETE FROM todo_items WHERE id = ?").run(found.id);
    else write(world, found);
    recordTodoEvent(world, op, before, op === "deleted" ? null : found);
    return result;
  });
}

export function updateTodo(world: World, ref: TodoRef, patch: TodoPatch): TodoResult<Todo> {
  return changeTodo(world, ref, "updated", (todo) => { applyPatch(todo, patch); return todo; });
}

export function completeTodo(world: World, ref: TodoRef): TodoResult<{ todo: Todo; alreadyDone: boolean }> {
  return changeTodo(world, ref, "completed", (todo) => {
    const alreadyDone = todo.done;
    applyPatch(todo, { done: true });
    return { todo, alreadyDone };
  });
}

export function deleteTodo(world: World, ref: TodoRef): TodoResult<Todo> {
  return changeTodo(world, ref, "deleted", (todo) => todo);
}

/** Adds todos from another store with their own ids, in their order. Skips
 * ids already present; never overwrites. One event for the whole import.
 */
export function importTodos(world: World, todos: readonly Todo[], source: string): { imported: number; skipped: number } {
  return world.tx((db) => {
    const exists = db.prepare("SELECT 1 FROM todo_items WHERE id = ?");
    const insert = db.prepare("INSERT INTO todo_items (id, position, payload) VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM todo_items), ?)");
    let imported = 0;
    let skipped = 0;
    for (const todo of todos) {
      if (exists.get(todo.id)) { skipped++; continue; }
      insert.run(todo.id, JSON.stringify(todo));
      imported++;
    }
    if (imported) recordDomainEvent(world, { kind: "todo.imported", subject: `import:${source}`.slice(0, 160), payload: { source, imported, skipped } });
    return { imported, skipped };
  });
}

const DUE: Record<string, (due: string) => string> = {
  overdue: (due) => ` (overdue, was due ${due})`, today: () => " (due today)", tomorrow: () => " (due tomorrow)",
  upcoming: (due) => ` (due ${due})`,
};

function dueBucket(due: string, today: string): keyof typeof DUE {
  if (due < today) return "overdue";
  if (due === today) return "today";
  const [y, m, d] = today.split("-").map(Number);
  return due === localDate(new Date(y, m - 1, d + 1)) ? "tomorrow" : "upcoming";
}

/** One line per todo, as a model reads it. */
export function formatTodo(todo: Todo, today: string = localDate()): string {
  const box = todo.done ? "[x]" : "[ ]";
  const date = todo.startDate && todo.due && todo.startDate !== todo.due
    ? ` (${todo.startDate} – ${todo.due}${!todo.done && todo.due < today ? ", overdue" : ""})`
    : todo.due && !todo.done ? DUE[dueBucket(todo.due, today)](todo.due) : todo.due ? ` (was due ${todo.due})` : "";
  const progress = todoStatus(todo) === "doing" ? " (in progress)" : "";
  const plan = todo.plannedOn ? ` (planned ${todo.plannedOn}, not a deadline)` : "";
  const link = todo.url ? ` -> ${todo.url}` : "";
  return `${box} ${todo.id}  ${todo.title}${progress}${date}${plan}${link}`;
}
