/** Todo types a device needs. No imports, so browser code can use them. */
export const TODO_STATUSES = ["todo", "doing", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  status?: TodoStatus;
  /** One explicitly chosen next task across the list; not a work date. */
  next?: boolean;
  /** First day of a multi-day task. Only with `due`. */
  startDate?: string;
  due?: string;
  /** Deliberate work date, never a deadline. */
  plannedOn?: string;
  /** Abandoned, not completed; reversible and left out of ordinary lists. */
  archivedAt?: string;
  url?: string;
  createdAt: string;
  completedAt?: string;
  /** Fields from Robin this version keeps but does not edit. */
  [kept: string]: unknown;
}

/** What a device draws: every non-archived todo with its revision, and the local date. */
export interface TodoSnapshot {
  today: string;
  todos: Array<Todo & { revision: string }>;
}
