import { localDate, type World } from "@alfred/core";
import { defineModule, defineOp, defineTool, Type } from "@alfred/module-kit";
import {
  addTodo, completeTodo, deleteTodo, formatTodo, listTodos, MIGRATIONS, todoRevision, updateTodo,
} from "./domain.ts";
import type { TodoSnapshot } from "./types.ts";

export * from "./domain.ts";
export type { TodoSnapshot } from "./types.ts";
export { readRobinTodos, compareTodos, robinDataDir, type TodoComparison } from "./import-robin.ts";

const Ref = {
  id: Type.Optional(Type.String({ description: "Todo id from todo_list" })),
  title: Type.Optional(Type.String({ description: "A distinctive part of the todo's current title, if the id is unknown" })),
};
const DateField = (description: string) => Type.Optional(Type.String({ description }));
const Status = Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done")]);

function snapshot(world: World): TodoSnapshot {
  return {
    today: localDate(),
    todos: listTodos(world, { includeDone: true }).map((todo) => ({ ...todo, revision: todoRevision(todo) })),
  };
}

/** The todo a tool call names, for steps and confirmations. */
function named(world: World, params: { id?: string; title?: string }): string {
  const todo = params.id ? listTodos(world, { includeDone: true, includeArchived: true }).find((candidate) => candidate.id === params.id) : undefined;
  return todo?.title ?? params.title ?? params.id ?? "";
}

function failed(result: { error: string } | object): result is { error: string } {
  return "error" in result;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export const todoModule = defineModule({
  id: "todo",
  title: "Todos",
  migrations: MIGRATIONS,
  snapshot,
  views: [{ id: "list", title: "待办" }],
  guidance: [
    "Todos: when the user mentions something they intend to do later, record it with todo_add instead of only acknowledging it.",
    "A todo has a due date, never a time. Resolve relative dates (\"Friday\", \"tomorrow\") against the local date you were given.",
    "For a task spanning several days, set startDate to its first day and due to its last day: one ranged todo, not one per day.",
    "Before editing or completing a todo you have not seen in this run, call todo_list to find its id.",
  ].join("\n"),

  ops: [
    defineOp({
      name: "todo.add", level: "local",
      input: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 500 }),
        due: Type.Optional(Type.String()), startDate: Type.Optional(Type.String()),
        plannedOn: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
      }),
      run: (world, input) => addTodo(world, input).todo,
    }),
    defineOp({
      name: "todo.update", level: "local",
      input: Type.Object({
        id: Type.String(), revision: Type.Optional(Type.String()),
        patch: Type.Object({
          title: Type.Optional(Type.String()), done: Type.Optional(Type.Boolean()), status: Type.Optional(Status),
          due: Type.Optional(Type.String()), startDate: Type.Optional(Type.String()),
          plannedOn: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
        }, { additionalProperties: false }),
      }),
      run: (world, input) => updateTodo(world, { id: input.id, revision: input.revision }, input.patch),
    }),
    defineOp({
      name: "todo.complete", level: "local",
      input: Type.Object({ id: Type.String(), revision: Type.Optional(Type.String()) }),
      run: (world, input) => completeTodo(world, input),
    }),
    defineOp({
      // Permanent: a device's explicit delete is the user's own decision; a run must ask first, every time.
      name: "todo.delete", level: "irreversible",
      input: Type.Object({ id: Type.String(), revision: Type.Optional(Type.String()) }),
      run: (world, input) => deleteTodo(world, input),
    }),
  ],

  tools: [
    defineTool({
      name: "todo_list", label: "List todos", level: "read",
      description: "List the user's todos with their ids, which the other todo tools accept. States the user's local date.",
      parameters: Type.Object({
        includeDone: Type.Optional(Type.Boolean({ description: "Include completed todos (default false)" })),
      }),
      execute(world, params) {
        const today = localDate();
        const todos = listTodos(world, { includeDone: params.includeDone });
        const header = `Today is ${today} (user's local date).`;
        return todos.length ? `${header}\n${todos.map((todo) => formatTodo(todo, today)).join("\n")}` : `${header}\nNo ${params.includeDone ? "" : "open "}todos.`;
      },
    }),
    defineTool({
      name: "todo_add", label: "Add todo", level: "local",
      description: "Add a task to the user's personal todo list.",
      parameters: Type.Object({
        title: Type.String({ description: "Short description of the task" }),
        due: DateField("Due date, or last day of a multi-day task, as YYYY-MM-DD in the user's local timezone"),
        startDate: DateField("First day of a multi-day task as YYYY-MM-DD. Only with due."),
        url: Type.Optional(Type.String({ description: "Link to where the task is actually done (http, https or mailto)" })),
      }),
      describe: (_world, params) => params.title,
      execute(world, params) {
        try {
          const { todo, open } = addTodo(world, params);
          return `Added ${formatTodo(todo)}\n${open} open todo(s).`;
        } catch (error) {
          return message(error);
        }
      },
    }),
    defineTool({
      name: "todo_update", label: "Update todo", level: "local",
      description: "Edit a todo's title, dates or link, or set it in progress. Identify it by id or by a distinctive part of its title.",
      parameters: Type.Object({
        ...Ref,
        newTitle: Type.Optional(Type.String({ description: "Replacement title" })),
        due: DateField("Replacement due date as YYYY-MM-DD, or an empty string to remove it"),
        startDate: DateField("Replacement first day as YYYY-MM-DD, or an empty string to remove it"),
        url: Type.Optional(Type.String({ description: "Replacement link, or an empty string to remove it" })),
        status: Type.Optional(Type.Union([Type.Literal("todo"), Type.Literal("doing")], { description: "todo or doing (in progress). Use todo_complete to finish." })),
      }),
      describe: (world, params) => named(world, params),
      execute(world, params) {
        const { id, title, newTitle, ...rest } = params;
        if (newTitle === undefined && Object.values(rest).every((value) => value === undefined)) return "Provide a newTitle, due, startDate, url or status to update.";
        try {
          const result = updateTodo(world, { id, title }, { ...rest, ...(newTitle !== undefined ? { title: newTitle } : {}) });
          return failed(result) ? result.error : `Updated ${formatTodo(result)}`;
        } catch (error) {
          return message(error);
        }
      },
    }),
    defineTool({
      name: "todo_complete", label: "Complete todo", level: "local",
      description: "Mark a todo as done. Identify it by id or by a distinctive part of its title.",
      parameters: Type.Object(Ref),
      describe: (world, params) => named(world, params),
      execute(world, params) {
        const result = completeTodo(world, params);
        if (failed(result)) return result.error;
        return `${result.alreadyDone ? "Already done" : "Completed"} ${formatTodo(result.todo)}`;
      },
    }),
    defineTool({
      name: "todo_delete", label: "Delete todo", level: "irreversible",
      description: "Permanently delete a todo. The user is asked to allow each deletion; only use it when they asked to delete or remove it, not to complete it.",
      parameters: Type.Object(Ref),
      describe: (world, params) => named(world, params),
      confirm: (world, params) => `永久删除待办「${named(world, params)}」？删除后不能恢复。`,
      execute(world, params) {
        const result = deleteTodo(world, params);
        return failed(result) ? result.error : `Deleted "${result.title}".`;
      },
    }),
  ],
});
