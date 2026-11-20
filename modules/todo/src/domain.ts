/** Todo rules, shared by device commands and agent tools. Ported from Robin's
 * todo-domain.ts. A todo is stored whole as JSON, so fields this version does
 * not edit yet (colour, estimate, work plan…) survive an import untouched.
 */
import { createHash } from "node:crypto";
import { AREA_IDS, changedFields, isArea, localDate, newId, recordDomainEvent, withDefaultActor, type World } from "@alfred/core";
import { CALENDAR_MODES, TODO_STATUSES, type CalendarMode, type Todo, type TodoRepeat, type TodoSettings, type TodoSource, type TodoStatus } from "./types.ts";

export { CALENDAR_MODES, TODO_STATUSES, type CalendarMode, type Todo, type TodoRepeat, type TodoSettings, type TodoSource, type TodoStatus };

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
  /** An area id (work, life…); empty string clears it. */
  area?: string;
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
}, {
  // Todos that come from somewhere (sources.ts in spirit, kept here with the rules): one row per source thing, so it
  // makes one todo, once. `seen` is what Alfred last wrote from it, to tell its own text from the user's edits.
  id: "todo:2",
  sql: `
CREATE TABLE todo_sources (
  ref TEXT PRIMARY KEY NOT NULL CHECK (length(ref) BETWEEN 1 AND 500),
  todo_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('linked', 'dismissed', 'gone')),
  seen TEXT CHECK (seen IS NULL OR json_valid(seen)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE todo_settings (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (json_valid(value))
) STRICT;
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
/** Open, and the user's: a suggestion is not theirs until they keep it. */
const isOpen = (todo: Todo) => !todo.done && !todo.archivedAt && !todo.suggested;

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

/** The todo a reference names now (by id, or a distinctive part of its title). */
export function resolveTodo(world: World, ref: TodoRef): TodoResult<Todo> {
  return findTodo(readAll(world), ref);
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
  if (patch.area !== undefined) {
    const area = patch.area.trim();
    if (area && !isArea(area)) throw new Error(`area must be one of: ${AREA_IDS.join(", ")}`);
    if (area) todo.area = area; else delete todo.area;
  }
}

type TodoOp = "added" | "updated" | "completed" | "deleted" | "suggested";

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
  return insertTodo(world, input, "added");
}

/** What of a todo Alfred wrote from its source, kept to tell later whether the user has changed it since. */
const seenOf = (todo: Todo) => ({ title: todo.title, due: todo.due ?? null, startDate: todo.startDate ?? null });

function insertTodo(world: World, input: { title: string } & TodoPatch, op: "added" | "suggested", from?: { source: TodoSource; account?: string; after?: string }): { todo: Todo; open: number } {
  if (!input.title?.trim()) throw new Error("title is required");
  const todo: Todo = { id: newId(), title: input.title.trim().slice(0, 500), done: false, status: "todo", createdAt: new Date().toISOString() };
  applyPatch(todo, input);
  if (from) todo.source = from.source;
  if (op === "suggested") todo.suggested = true;
  return world.tx((db) => {
    const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_items").get()!.next as number);
    db.prepare("INSERT INTO todo_items (id, position, payload) VALUES (?, ?, ?)").run(todo.id, position, JSON.stringify(todo));
    if (from) {
      // A source has one row; what repeats weekly moves its row on to the todo of its next time.
      db.prepare(`INSERT INTO todo_sources (ref, todo_id, state, seen, updated_at) VALUES (?, ?, 'linked', ?, ?)
        ON CONFLICT(ref) DO UPDATE SET todo_id = excluded.todo_id, state = 'linked', seen = excluded.seen, updated_at = excluded.updated_at`)
        .run(from.source.ref, todo.id, JSON.stringify({ ...seenOf(todo), ...(from.account ? { account: from.account } : {}), ...(from.after ? { after: from.after } : {}) }), new Date().toISOString());
    }
    recordTodoEvent(world, op, null, todo);
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
    // Whoever changes or finishes a suggestion has kept it.
    if (op !== "deleted") delete found.suggested;
    if (op === "deleted") {
      db.prepare("DELETE FROM todo_items WHERE id = ?").run(found.id);
      // Removed by the user (or on their yes): its source does not make it again. (A finished time of what repeats
      // is no longer the todo its source keeps: removing that one says nothing.)
      if (found.source) db.prepare("UPDATE todo_sources SET state = 'dismissed', todo_id = NULL, updated_at = ? WHERE ref = ? AND todo_id = ?").run(new Date().toISOString(), found.source.ref, found.id);
    } else write(world, found);
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

/** The user keeps a suggestion: it is their todo from now on. */
export function acceptTodo(world: World, ref: TodoRef): TodoResult<Todo> {
  return changeTodo(world, ref, "updated", (todo) => todo);
}

// ---- where todos come from, besides the user's own words ---------------------------------------------------

const DEFAULT_SETTINGS: TodoSettings = { fromCalendar: "allday" };

export function getTodoSettings(world: World): TodoSettings {
  const row = world.db.prepare("SELECT value FROM todo_settings WHERE key = 'fromCalendar'").get();
  const mode = row ? JSON.parse(row.value as string) as CalendarMode : DEFAULT_SETTINGS.fromCalendar;
  return { fromCalendar: CALENDAR_MODES.includes(mode) ? mode : DEFAULT_SETTINGS.fromCalendar };
}

export function setTodoSettings(world: World, patch: Partial<TodoSettings>): TodoSettings {
  if (patch.fromCalendar !== undefined && !CALENDAR_MODES.includes(patch.fromCalendar)) throw new Error(`fromCalendar must be one of: ${CALENDAR_MODES.join(", ")}`);
  return world.tx((db) => {
    const before = getTodoSettings(world);
    if (patch.fromCalendar !== undefined && patch.fromCalendar !== before.fromCalendar) {
      db.prepare("INSERT INTO todo_settings (key, value) VALUES ('fromCalendar', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(patch.fromCalendar));
      recordDomainEvent(world, { kind: "todo.sources_set", subject: "todo:settings", payload: { fromCalendar: patch.fromCalendar, was: before.fromCalendar } });
    }
    return getTodoSettings(world);
  });
}

/** Alfred's suggestion from one thing it read (a mail): a todo that waits, marked as a suggestion, for the user to
 * keep or drop. The same thing is suggested once: not again while its todo is there, and not after the user said no. */
export function suggestTodo(world: World, input: { title: string; due?: string; area?: string; source: TodoSource }): TodoResult<Todo> {
  return world.tx((db) => {
    const known = db.prepare("SELECT state FROM todo_sources WHERE ref = ?").get(input.source.ref);
    if (known) return { error: known.state === "dismissed" ? "The user already said no to a todo from this; do not suggest it again." : "A todo from this was already suggested." };
    const source: TodoSource = { ...input.source, label: input.source.label.replace(/\s+/g, " ").trim().slice(0, 200) };
    return insertTodo(world, { title: input.title, ...(input.due ? { due: input.due } : {}), ...(input.area ? { area: input.area } : {}) }, "suggested", { source }).todo;
  });
}

/** A calendar event as the mirror needs it (the calendar module's events fit). */
export interface SourceEvent {
  id: string;
  account: string;
  calendar: string;
  title: string;
  allDay: boolean;
  /** Local dates, inclusive. */
  startDate: string;
  endDate: string;
  /** When it starts (ISO), if it has a time. */
  start?: string;
  link?: string;
  response?: string;
  /** One time of an event that repeats: what names the repeating event. */
  recurring?: string;
}

/** How far ahead an event becomes a todo. */
export const CALENDAR_AHEAD_DAYS = 14;

function plusDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

const dayNumber = (date: string) => { const [y, m, d] = date.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86_400_000); };

/** The weekdays and the hour of an event that repeats, from the times of it that were read. A time moved once to
 * another day is not one of its days: a weekday counts when it comes up at least half as often as the usual one. */
function repeatOf(times: readonly SourceEvent[]): TodoRepeat {
  const days = new Map<number, number>();
  for (const date of new Set(times.map((event) => event.startDate))) {
    const weekday = (dayNumber(date) + 4) % 7; // 1970-01-01 was a Thursday
    days.set(weekday, (days.get(weekday) ?? 0) + 1);
  }
  const most = Math.max(...days.values());
  const usual = [...days].filter(([, count]) => count * 2 >= most).map(([weekday]) => weekday);
  const clocks = new Map<string, number>();
  for (const event of times) {
    if (event.allDay || !event.start) continue;
    const at = new Date(event.start);
    if (Number.isNaN(at.getTime())) continue;
    const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    clocks.set(clock, (clocks.get(clock) ?? 0) + 1);
  }
  const at = [...clocks].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return { days: usual.sort((a, b) => a - b), ...(at ? { at } : {}) };
}

type Seen = { title: string; due: string | null; startDate: string | null; account?: string; after?: string };

/** Keeps todos in step with the calendar, one way: an event of the next two weeks (all-day ones only, or all, as
 * `mode` says; never one the user declined) is a todo due on its day, made once. While the user has not touched
 * that todo it follows the event (a new title, a new day), and leaves the list if the event is removed; once they
 * have changed it, finished it or removed it, it is theirs and is left alone. `healthy`: the accounts whose calendar
 * was read without trouble; an account that could not be read removes nothing.
 *
 * An event that repeats every week or more often is one todo, not one for each time: it stands for the next time.
 * Untouched, it moves on by itself when that day has passed (a missed class is not an overdue todo); finished, the
 * todo for the time after it is made; removed, the whole of it stays out of the list. What repeats less often
 * (monthly rent, a birthday) is a todo each time, as any event is. */
export function mirrorCalendar(
  world: World,
  events: readonly SourceEvent[],
  options: { today: string; healthy: ReadonlySet<string>; mode: CalendarMode },
): { added: number; updated: number; removed: number } {
  const done = { added: 0, updated: 0, removed: 0 };
  if (options.mode === "off") return done;
  const horizon = plusDays(options.today, CALENDAR_AHEAD_DAYS);
  const refOf = (event: SourceEvent) => `calendar:${event.account}:${event.id}`;
  const repeatRef = (event: SourceEvent) => `calendar:${event.account}:repeat:${event.recurring}`;
  const covered = (event: SourceEvent) => !(options.mode === "allday" && !event.allDay) && event.response !== "declined" && !!event.title.trim();
  const coming = (event: SourceEvent) => event.endDate >= options.today && event.startDate <= horizon;
  const shape = (event: SourceEvent) => {
    const title = event.title.trim().slice(0, 500);
    // A timed event is due the day it starts; an all-day one that spans days is a range.
    const due = event.allDay ? event.endDate : event.startDate;
    return { title, due, startDate: event.allDay && event.startDate !== event.endDate ? event.startDate : null };
  };
  return withDefaultActor("system", () => world.tx((db) => {
    const now = new Date().toISOString();
    const rows = new Map(db.prepare("SELECT ref, todo_id, state, seen FROM todo_sources WHERE ref >= 'calendar:' AND ref < 'calendar;'").all().map((row) => [row.ref as string, row]));
    const todos = new Map(readAll(world).map((todo) => [todo.id, todo]));
    const seenOfRow = (row: { seen?: unknown }) => row.seen ? JSON.parse(row.seen as string) as Seen : null;
    const untouched = (todo: Todo, seen: Seen) => todo.title === seen.title && (todo.due ?? null) === seen.due && (todo.startDate ?? null) === seen.startDate;

    // What repeats weekly or more often: two of its times a week apart or less, or already kept as one todo (so
    // its last time, read alone, is still part of it).
    const times = new Map<string, SourceEvent[]>();
    for (const event of events) {
      if (!event.recurring || !covered(event)) continue;
      const ref = repeatRef(event);
      times.set(ref, [...(times.get(ref) ?? []), event]);
    }
    const weekly = new Map<string, SourceEvent[]>();
    const folded = new Set<string>();
    for (const [ref, all] of times) {
      all.sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.start ?? "").localeCompare(b.start ?? ""));
      const days = [...new Set(all.map((event) => dayNumber(event.startDate)))];
      if (!rows.has(ref) && !days.some((day, index) => index > 0 && day - days[index - 1] <= 7)) continue;
      weekly.set(ref, all);
      for (const event of all) folded.add(refOf(event));
    }
    const wanted = new Map<string, SourceEvent>();
    for (const event of events) {
      if (!covered(event) || !coming(event) || folded.has(refOf(event))) continue;
      wanted.set(refOf(event), event);
    }

    for (const [ref, event] of wanted) {
      const next = shape(event);
      const row = rows.get(ref);
      if (!row) {
        const source: TodoSource = { kind: "calendar", ref, label: event.calendar.slice(0, 200), ...(event.link ? { link: event.link } : {}) };
        insertTodo(world, { title: next.title, due: next.due, ...(next.startDate ? { startDate: next.startDate } : {}) }, "added", { source, account: event.account });
        done.added++;
        continue;
      }
      if (row.state !== "linked") continue;
      const todo = row.todo_id ? todos.get(row.todo_id as string) : undefined;
      const seen = seenOfRow(row);
      if (!todo || todo.done || todo.archivedAt || !seen) continue;
      const same = next.title === seen.title && next.due === seen.due && next.startDate === seen.startDate;
      if (!untouched(todo, seen) || same) continue;
      const before = structuredClone(todo);
      todo.title = next.title;
      todo.due = next.due;
      if (next.startDate) todo.startDate = next.startDate; else delete todo.startDate;
      write(world, todo);
      db.prepare("UPDATE todo_sources SET seen = ?, updated_at = ? WHERE ref = ?").run(JSON.stringify({ ...next, account: event.account }), now, ref);
      recordTodoEvent(world, "updated", before, todo);
      done.updated++;
    }

    for (const [ref, all] of weekly) {
      const row = rows.get(ref);
      if (row && row.state !== "linked") continue;
      const repeat = repeatOf(all);
      const ahead = all.filter(coming);
      const sourceOf = (event: SourceEvent): TodoSource => ({ kind: "calendar", ref, label: event.calendar.slice(0, 200), ...(event.link ? { link: event.link } : {}), repeat });
      const make = (event: SourceEvent, kept: { area?: string; after?: string } = {}) => {
        const next = shape(event);
        insertTodo(world, { title: next.title, due: next.due, ...(next.startDate ? { startDate: next.startDate } : {}), ...(kept.area ? { area: kept.area } : {}) }, "added",
          { source: sourceOf(event), account: event.account, ...(kept.after ? { after: kept.after } : {}) });
        done.added++;
      };
      if (!row) { if (ahead[0]) make(ahead[0]); continue; }
      const todo = row.todo_id ? todos.get(row.todo_id as string) : undefined;
      const seen = seenOfRow(row);
      if (!todo || todo.archivedAt || !seen) continue;
      if (todo.done) {
        // That time is done: the time after it is the todo now, in the area the user gave the last one.
        const after = seen.due ?? options.today;
        const event = ahead.find((candidate) => candidate.startDate > after);
        if (event) make(event, { area: todo.area, after });
        continue;
      }
      // Never back onto a time already done (today's, finished this morning).
      const event = ahead.find((candidate) => !seen.after || candidate.startDate > seen.after);
      if (!event || !untouched(todo, seen)) continue;
      const next = shape(event);
      const source = sourceOf(event);
      const same = next.title === seen.title && next.due === seen.due && next.startDate === seen.startDate;
      if (same && JSON.stringify(todo.source) === JSON.stringify(source)) continue;
      const before = structuredClone(todo);
      todo.title = next.title;
      todo.due = next.due;
      if (next.startDate) todo.startDate = next.startDate; else delete todo.startDate;
      todo.source = source;
      write(world, todo);
      db.prepare("UPDATE todo_sources SET seen = ?, updated_at = ? WHERE ref = ?").run(JSON.stringify({ ...next, account: event.account, ...(seen.after ? { after: seen.after } : {}) }), now, ref);
      recordTodoEvent(world, "updated", before, todo);
      done.updated++;
    }

    // An event that is gone from a calendar that was read: its todo goes too, unless the user has made it theirs.
    // So does a todo made for one time of what is now one todo for all its times.
    for (const [ref, row] of rows) {
      if (wanted.has(ref) || weekly.has(ref) || row.state !== "linked" || !row.todo_id) continue;
      const seen = seenOfRow(row);
      const todo = todos.get(row.todo_id as string);
      if (!seen || !todo || todo.done || todo.archivedAt || !untouched(todo, seen)) continue;
      if (!folded.has(ref)) {
        if (!seen.account || !options.healthy.has(seen.account)) continue;
        // Past its day it is simply an overdue todo; and one the mode no longer covers stays as it is.
        if (!seen.due || seen.due < options.today || seen.due > horizon) continue;
        if (events.some((event) => refOf(event) === ref || (!!event.recurring && repeatRef(event) === ref))) continue;
      }
      const before = structuredClone(todo);
      todo.archivedAt = now;
      write(world, todo);
      db.prepare("UPDATE todo_sources SET state = 'gone', updated_at = ? WHERE ref = ?").run(now, ref);
      recordTodoEvent(world, "updated", before, todo);
      done.removed++;
    }
    return done;
  }));
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One line per todo, as a model reads it. */
export function formatTodo(todo: Todo, today: string = localDate()): string {
  const box = todo.done ? "[x]" : "[ ]";
  const date = todo.startDate && todo.due && todo.startDate !== todo.due
    ? ` (${todo.startDate} – ${todo.due}${!todo.done && todo.due < today ? ", overdue" : ""})`
    : todo.due && !todo.done ? DUE[dueBucket(todo.due, today)](todo.due) : todo.due ? ` (was due ${todo.due})` : "";
  const progress = todoStatus(todo) === "doing" ? " (in progress)" : "";
  const plan = todo.plannedOn ? ` (planned ${todo.plannedOn}, not a deadline)` : "";
  const link = todo.url ? ` -> ${todo.url}` : "";
  const area = todo.area ? ` [area: ${todo.area}]` : "";
  const repeat = todo.source?.repeat;
  const repeats = repeat ? `; repeats ${repeat.days.length === 7 ? "every day" : repeat.days.map((day) => WEEKDAYS[day]).join(", ")}${repeat.at ? ` at ${repeat.at}` : ""}, this is its next time` : "";
  const from = todo.suggested ? " (your suggestion; the user has not kept it yet)" : todo.source?.kind === "calendar" ? ` (from the calendar${repeats})` : todo.source?.kind === "mail" ? " (from mail)" : "";
  return `${box} ${todo.id}  ${todo.title}${area}${progress}${date}${plan}${from}${link}`;
}
