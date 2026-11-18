import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CORE_MIGRATIONS, listEvents, openWorld, type World } from "@alfred/core";
import { invokeOp, moduleMigrations, OpInputError, runTools } from "@alfred/module-kit";
import {
  addTodo, compareTodos, completeTodo, importTodos, listTodos, readRobinTodos, TodoConflictError, todoModule,
  todoRevision, updateTodo, type Todo,
} from "../src/index.ts";

function world(): World {
  return openWorld(":memory:", [...CORE_MIGRATIONS, ...moduleMigrations([todoModule])]);
}

test("every change writes its event in the same transaction", () => {
  const w = world();
  const { todo } = addTodo(w, { title: "  Hand in report ", due: "2026-11-20" });
  assert.equal(todo.title, "Hand in report");
  updateTodo(w, { id: todo.id }, { due: "2026-11-21" });
  completeTodo(w, { title: "report" });
  const kinds = listEvents(w).events.map((event) => event.kind);
  assert.deepEqual(kinds, ["todo.added", "todo.updated", "todo.completed"]);
  const updated = listEvents(w).events[1];
  assert.deepEqual((updated.payload.changes as Record<string, unknown>).due, ["2026-11-20", "2026-11-21"]);
  assert.equal(listTodos(w).length, 0);
  assert.equal(listTodos(w, { includeDone: true })[0].done, true);
});

test("invalid input changes nothing and records nothing", () => {
  const w = world();
  assert.throws(() => addTodo(w, { title: "x", due: "2026-02-30" }), /not a real date/);
  assert.throws(() => addTodo(w, { title: "x", startDate: "2026-11-20" }), /due is required/);
  assert.throws(() => addTodo(w, { title: "x", url: "javascript:alert(1)" }), /link/);
  assert.equal(listTodos(w, { includeDone: true }).length, 0);
  assert.equal(listEvents(w).events.length, 0);
});

test("an edit made on a stale copy is refused", () => {
  const w = world();
  const { todo } = addTodo(w, { title: "Call the bank" });
  const stale = todoRevision(todo);
  updateTodo(w, { id: todo.id }, { title: "Call the bank about the card" });
  assert.throws(() => updateTodo(w, { id: todo.id, revision: stale }, { title: "x" }), TodoConflictError);
});

test("a title that matches several todos asks for an id", () => {
  const w = world();
  addTodo(w, { title: "Email Alice" });
  addTodo(w, { title: "Email Bob" });
  const result = completeTodo(w, { title: "email" });
  assert.ok("error" in result && /matches 2 todos/.test(result.error));
});

test("device commands replay by request id and validate their input", () => {
  const w = world();
  const first = invokeOp(w, [todoModule], { op: "todo.add", requestId: "c1", input: { title: "Buy milk" } });
  const again = invokeOp(w, [todoModule], { op: "todo.add", requestId: "c1", input: { title: "Buy milk" } });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.result, first.result);
  assert.equal(listTodos(w).length, 1);
  assert.equal(listEvents(w).events[0].actor, "user");
  assert.throws(() => invokeOp(w, [todoModule], { op: "todo.add", requestId: "c2", input: { title: 3 } }), OpInputError);
});

test("runs use reversible tools directly; deleting asks the user, naming the todo", () => {
  const w = world();
  const { todo } = addTodo(w, { title: "Old receipt" });
  const tools = runTools(w, [todoModule]);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["todo_add", "todo_complete", "todo_delete", "todo_list", "todo_update"]);
  assert.deepEqual(tools.filter((tool) => tool.permission).map((tool) => tool.name), ["todo_delete"]);
  const remove = tools.find((tool) => tool.name === "todo_delete")!;
  assert.equal(remove.permission!({ id: todo.id }), "永久删除待办「Old receipt」？删除后不能恢复。");
  assert.equal(remove.describe!({ id: todo.id }), "Old receipt");
});

test("an import keeps Robin's records exactly, reads Robin without writing, and never overwrites", () => {
  const robin = mkdtempSync(join(tmpdir(), "robin-"));
  const records: Todo[] = [
    { id: "a1", title: "Old task", done: false, status: "todo", createdAt: "2026-10-01T00:00:00.000Z", color: "blue", workPlan: { slots: [] } },
    { id: "b2", title: "Done task", done: true, status: "done", createdAt: "2026-10-02T00:00:00.000Z", completedAt: "2026-10-03T00:00:00.000Z" },
  ];
  const db = new DatabaseSync(join(robin, "tasks.sqlite"));
  db.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL)");
  records.forEach((todo, index) => db.prepare("INSERT INTO todos VALUES (?, ?, ?)").run(todo.id, index, JSON.stringify(todo)));
  db.close();
  writeFileSync(join(robin, "task-storage.json"), JSON.stringify({ backend: "sqlite", schemaVersion: 4 }));

  const w = world();
  const { todos } = readRobinTodos(robin);
  assert.deepEqual(importTodos(w, todos, "robin"), { imported: 2, skipped: 0 });
  assert.deepEqual(compareTodos(w, todos), { same: 2, differ: [], missing: [], extra: [] });
  assert.deepEqual(importTodos(w, todos, "robin"), { imported: 0, skipped: 2 });

  updateTodo(w, { id: "a1" }, { title: "Changed in Alfred" });
  addTodo(w, { title: "New in Alfred" });
  const drift = compareTodos(w, todos);
  assert.deepEqual([drift.same, drift.differ, drift.missing, drift.extra.length], [1, ["a1"], [], 1]);
  assert.equal(listEvents(w).events.filter((event) => event.kind === "todo.imported").length, 1);
});
