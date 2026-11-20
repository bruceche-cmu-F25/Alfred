/** Todo types a device needs. No imports, so browser code can use them. */
export const TODO_STATUSES = ["todo", "doing", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** A calendar event that repeats every week or more often has one todo for all of it, standing for its next time.
 * `days`: the weekdays it falls on (0 Sunday … 6 Saturday); `at`: when it starts (HH:MM by the home node's clock),
 * if it has a time. */
export interface TodoRepeat { days: number[]; at?: string }

/** Where a todo came from, when the user did not write it: a calendar event Alfred mirrors, or a mail Alfred
 * picked it out of. `ref` names that one thing (`calendar:<account>:<event id>`, or
 * `calendar:<account>:repeat:<repeating event>` for one that repeats weekly; `mail:<message id>`): it never makes
 * a second todo at a time, and a todo the user removed is not made again. */
export interface TodoSource {
  kind: "calendar" | "mail";
  ref: string;
  /** What to call the source: the calendar's name, the mail's subject. */
  label: string;
  /** The event or the message at its service. */
  link?: string;
  /** Set on the one todo of an event that repeats weekly. */
  repeat?: TodoRepeat;
}

/** Which calendar events become todos by themselves: none, the all-day ones (deadlines, days to remember), or all. */
export const CALENDAR_MODES = ["off", "allday", "all"] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];
export interface TodoSettings { fromCalendar: CalendarMode }

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
  /** The area of life it belongs to (core's AREAS ids, e.g. `work`). */
  area?: string;
  createdAt: string;
  completedAt?: string;
  source?: TodoSource;
  /** Alfred's suggestion (from mail), not yet the user's todo: kept with a yes or any edit, dropped with a no. */
  suggested?: boolean;
  /** Fields from Robin this version keeps but does not edit. */
  [kept: string]: unknown;
}

/** What a device draws: every non-archived todo with its revision, and the local date. `changedBy` says Alfred
 * made the latest change to it (read from the event log), and which kind of change. */
export interface TodoSnapshot {
  today: string;
  /** What becomes a todo by itself. Absent from a home node older than this field. */
  settings?: TodoSettings;
  todos: Array<Todo & { revision: string; changedBy?: { actor: "alfred"; kind: string; at: string } }>;
}
