/** Reads Robin's todos without changing anything in Robin's data directory.
 * Robin keeps them either in tasks.sqlite (once migrated) or in todos.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { World } from "@alfred/core";
import { listTodos, todoRevision, type Todo } from "./domain.ts";

export function robinDataDir(): string {
  return process.env.ROBIN_DATA_DIR || join(homedir(), ".pi", "robin");
}

export function readRobinTodos(dir: string = robinDataDir()): { todos: Todo[]; from: string } {
  const selection = join(dir, "task-storage.json");
  const database = join(dir, "tasks.sqlite");
  if (existsSync(selection) && existsSync(database)) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const rows = db.prepare("SELECT payload FROM todos ORDER BY position").all();
      return { todos: rows.map((row) => JSON.parse(row.payload as string) as Todo), from: database };
    } finally {
      db.close();
    }
  }
  const json = join(dir, "todos.json");
  if (existsSync(json)) {
    const value: unknown = JSON.parse(readFileSync(json, "utf8"));
    if (!Array.isArray(value)) throw new Error(`${json} is not a todo list`);
    return { todos: value as Todo[], from: json };
  }
  throw new Error(`No Robin todos found in ${dir}`);
}

export interface TodoComparison { same: number; differ: string[]; missing: string[]; extra: string[] }

/** Whether Alfred's todos match a list from Robin, record by record. */
export function compareTodos(world: World, robin: readonly Todo[]): TodoComparison {
  const ours = new Map(listTodos(world, { includeDone: true, includeArchived: true }).map((todo) => [todo.id, todo]));
  const theirs = new Set(robin.map((todo) => todo.id));
  const result: TodoComparison = { same: 0, differ: [], missing: [], extra: [] };
  for (const todo of robin) {
    const mine = ours.get(todo.id);
    if (!mine) result.missing.push(todo.id);
    else if (todoRevision(mine) === todoRevision(todo)) result.same++;
    else result.differ.push(todo.id);
  }
  for (const id of ours.keys()) if (!theirs.has(id)) result.extra.push(id);
  return result;
}
