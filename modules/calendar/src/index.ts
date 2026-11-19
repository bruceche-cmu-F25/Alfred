/** The calendar module: the user's Google Calendar, mirrored for reading (docs/design/workspace-architecture.md W6).
 *
 * Google is the source of truth; Alfred keeps no second calendar. A sync every few minutes reads each connected
 * account's shown calendars, a week back to five weeks ahead, and replaces that account's events here. Devices and
 * runs read the mirror, so a question about the schedule never waits on Google. Writing (moving a meeting, holding
 * time) comes later, and only as a proposal.
 */
import { createHash } from "node:crypto";
import { localDate, recordDomainEvent, withDefaultActor, type World } from "@alfred/core";
import { defineModule, defineTool, ServiceError, Type, type ModuleServices } from "@alfred/module-kit";
import { addDays, readAccount, type EventRow } from "./google.ts";
import type { CalendarEvent, CalendarSnapshot, CalendarSource } from "./types.ts";

export type { CalendarEvent, CalendarSnapshot, CalendarSource } from "./types.ts";
export { mapEvent, addDays, type GoogleEvent } from "./google.ts";

const WINDOW = { back: 7, ahead: 35 };
/** Colour slots for calendars, in order: the first account's primary calendar is blue. */
const KS = ["blue", "green", "orange", "violet", "teal", "pink", "yellow"];

const MIGRATIONS = [{
  id: "calendar:1",
  sql: `
CREATE TABLE calendar_events (
  account TEXT NOT NULL CHECK (length(account) BETWEEN 1 AND 320),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 300),
  calendar_id TEXT NOT NULL,
  calendar TEXT NOT NULL,
  title TEXT NOT NULL,
  all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  location TEXT,
  link TEXT,
  meeting TEXT,
  organizer TEXT,
  response TEXT,
  attendees INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, id)
) STRICT;
CREATE INDEX calendar_events_day ON calendar_events(start_date, start_at);
CREATE TABLE calendar_sources (
  account TEXT PRIMARY KEY NOT NULL,
  synced_at TEXT,
  error TEXT,
  reconnect INTEGER NOT NULL DEFAULT 0 CHECK (reconnect IN (0, 1)),
  calendars TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(calendars)),
  digest TEXT
) STRICT;
`,
}];

const canRead = (capabilities: readonly string[]) => capabilities.includes("calRead") || capabilities.includes("calWrite");

/** Reads every connected account; one that fails keeps its last events and says why. Records `calendar.synced` only
 * when something changed, so devices refresh without the log filling up every few minutes. */
export async function syncCalendar(world: World, services: ModuleServices, signal?: AbortSignal, now: number = Date.now()): Promise<void> {
  const google = services.google;
  const accounts = (google?.accounts() ?? []).filter((account) => canRead(account.capabilities)).map((account) => account.email);
  const today = localDate(new Date(now));
  withDefaultActor("system", () => world.tx((db) => {
    const gone = db.prepare("SELECT account FROM calendar_sources").all().map((row) => row.account as string).filter((account) => !accounts.includes(account));
    for (const account of gone) {
      db.prepare("DELETE FROM calendar_events WHERE account = ?").run(account);
      db.prepare("DELETE FROM calendar_sources WHERE account = ?").run(account);
      recordDomainEvent(world, { kind: "calendar.synced", subject: `calendar:${account}`, payload: { removed: true } });
    }
  }));
  for (const account of accounts) {
    if (signal?.aborted) return;
    let result: Awaited<ReturnType<typeof readAccount>> | null = null;
    let failure: { error: string; reconnect: boolean } | null = null;
    try {
      const session = await google!.session(account);
      result = await readAccount(session, addDays(today, -WINDOW.back), addDays(today, WINDOW.ahead), signal);
    } catch (error) {
      if (signal?.aborted) return;
      failure = { error: (error as Error).message.slice(0, 300), reconnect: error instanceof ServiceError && error.code === "reconnect" };
    }
    withDefaultActor("system", () => world.tx((db) => {
      const before = db.prepare("SELECT digest, error FROM calendar_sources WHERE account = ?").get(account);
      if (failure) {
        db.prepare(`INSERT INTO calendar_sources (account, error, reconnect) VALUES (?, ?, ?)
          ON CONFLICT(account) DO UPDATE SET error = excluded.error, reconnect = excluded.reconnect`).run(account, failure.error, failure.reconnect ? 1 : 0);
        if (before?.error !== failure.error) recordDomainEvent(world, { kind: "calendar.synced", subject: `calendar:${account}`, payload: { error: failure.error } });
        return;
      }
      const digest = createHash("sha256").update(JSON.stringify(result!)).digest("hex");
      db.prepare(`INSERT INTO calendar_sources (account, synced_at, error, reconnect, calendars, digest) VALUES (?, ?, NULL, 0, ?, ?)
        ON CONFLICT(account) DO UPDATE SET synced_at = excluded.synced_at, error = NULL, reconnect = 0, calendars = excluded.calendars, digest = excluded.digest`)
        .run(account, new Date(now).toISOString(), JSON.stringify(result!.calendars), digest);
      if (before?.digest === digest && !before?.error) return;
      db.prepare("DELETE FROM calendar_events WHERE account = ?").run(account);
      const insert = db.prepare(`INSERT OR REPLACE INTO calendar_events (account, id, calendar_id, calendar, title, all_day, start_date, end_date, start_at, end_at,
        location, link, meeting, organizer, response, attendees) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const event of result!.events) {
        insert.run(account, event.id, event.calendarId, event.calendar, event.title, event.allDay ? 1 : 0, event.startDate, event.endDate,
          event.startAt, event.endAt, event.location, event.link, event.meeting, event.organizer, event.response, event.attendees);
      }
      recordDomainEvent(world, { kind: "calendar.synced", subject: `calendar:${account}`, payload: { events: result!.events.length } });
    }));
  }
}

export function calendarSources(world: World): CalendarSource[] {
  let next = 0;
  return world.db.prepare("SELECT * FROM calendar_sources ORDER BY account").all().map((row) => ({
    account: row.account as string,
    syncedAt: row.synced_at as string | null,
    error: row.error as string | null,
    reconnect: row.reconnect === 1,
    calendars: (JSON.parse(row.calendars as string) as Array<{ id: string; name: string }>).map((calendar) => ({ ...calendar, k: KS[next++ % KS.length] })),
  }));
}

/** Events touching the days from `from` to `to` (inclusive), by start. */
export function listEvents(world: World, from: string, to: string): CalendarEvent[] {
  const colour = new Map(calendarSources(world).flatMap((source) => source.calendars.map((calendar) => [`${source.account}|${calendar.id}`, calendar.k] as const)));
  return world.db.prepare(`SELECT * FROM calendar_events WHERE end_date >= ? AND start_date <= ?
    ORDER BY start_date, all_day DESC, start_at, title`).all(from, to).map((row) => ({
    id: row.id as string, account: row.account as string, calendarId: row.calendar_id as string, calendar: row.calendar as string,
    title: row.title as string, allDay: row.all_day === 1, startDate: row.start_date as string, endDate: row.end_date as string,
    ...(row.start_at !== null ? { start: new Date(row.start_at as number).toISOString(), end: new Date(row.end_at as number).toISOString() } : {}),
    ...(row.location ? { location: row.location as string } : {}),
    ...(row.link ? { link: row.link as string } : {}),
    ...(row.meeting ? { meeting: row.meeting as string } : {}),
    ...(row.organizer ? { organizer: row.organizer as string } : {}),
    ...(row.response ? { response: row.response as CalendarEvent["response"] } : {}),
    attendees: row.attendees as number,
    k: colour.get(`${row.account as string}|${row.calendar_id as string}`) ?? "gray",
  }));
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (iso: string) => { const date = new Date(iso); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };

/** The schedule as a run reads it: day by day, with what could not be read. */
export function describeEvents(world: World, from: string, to: string): string {
  const sources = calendarSources(world);
  if (!sources.length) return "The user's calendar is not connected. They can connect Google (calendar) in Settings.";
  const events = listEvents(world, from, to);
  const lines: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const [y, m, d] = day.split("-").map(Number);
    const todays = events.filter((event) => event.startDate <= day && event.endDate >= day);
    lines.push(`${DAY[new Date(y, m - 1, d).getDay()]} ${day}${todays.length ? "" : ": nothing"}`);
    for (const event of todays) {
      const when = event.allDay || !event.start ? "all day" : `${event.startDate === day ? hhmm(event.start) : "…"}–${event.endDate === day ? hhmm(event.end!) : "…"}`;
      const extra = [event.location, event.response === "declined" ? "declined" : event.response === "needsAction" ? "not answered" : null, sources.length > 1 || sources[0].calendars.length > 1 ? event.calendar : null]
        .filter(Boolean).join("; ");
      lines.push(`  ${when} ${event.title}${extra ? ` (${extra})` : ""}`);
    }
  }
  const notes = sources.map((source) => source.error ? `Could not read ${source.account} just now (${source.error}); this may be out of date.` : null).filter(Boolean);
  const synced = sources.map((source) => source.syncedAt).filter(Boolean).sort().at(-1);
  return [...lines, ...(synced ? [`(Read from Google at ${hhmm(synced!)}.)`] : []), ...notes].join("\n");
}

const Day = (description: string) => Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description }));

export const calendarModule = defineModule({
  id: "calendar",
  title: "Calendar",
  migrations: MIGRATIONS,
  ops: [],
  tools: [
    defineTool({
      name: "calendar_list",
      label: "Calendar",
      description: "The user's schedule from their Google Calendar, day by day: times, titles, places, and invitations they declined or have not answered. Use it for questions about their day, free time, or what is coming up.",
      level: "read",
      parameters: Type.Object({
        from: Day("First day, YYYY-MM-DD; today if left out"),
        to: Day("Last day, YYYY-MM-DD, at most 35 days after from; a week from `from` if left out"),
      }),
      describe: (_world, params) => [params.from, params.to].filter(Boolean).join(" – "),
      execute(world, params) {
        const from = params.from ?? localDate();
        let to = params.to ?? addDays(from, 6);
        if (to < from) to = from;
        if (to > addDays(from, 35)) to = addDays(from, 35);
        return describeEvents(world, from, to);
      },
    }),
  ],
  views: [{ id: "week", title: "Calendar" }],
  guidance: [
    "Calendar: the user's Google Calendar is mirrored here and refreshed every few minutes; calendar_list reads it.",
    "You cannot add, move or decline events yet. If asked to, say so, and offer to add a todo instead.",
  ].join(" "),
  snapshot(world): CalendarSnapshot {
    const today = localDate();
    return { today, events: listEvents(world, addDays(today, -WINDOW.back), addDays(today, WINDOW.ahead)), sources: calendarSources(world) };
  },
  sync: { everyMs: 5 * 60_000, run: (world, services, signal) => syncCalendar(world, services, signal) },
});
