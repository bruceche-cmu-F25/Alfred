import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent, CalendarSnapshot } from "@alfred/module-calendar/types";
import { SourceBar } from "./SourceBar.tsx";
import { intlLocale, t } from "./i18n/index.ts";

const HOUR = 48;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parse = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (day: string, n: number) => { const date = parse(day); date.setDate(date.getDate() + n); return ymd(date); };
/** Weeks start on Monday. */
const mondayOf = (day: string) => addDays(day, -((parse(day).getDay() + 6) % 7));
const hhmm = (iso: string) => { const date = new Date(iso); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const minutesOf = (iso: string) => { const date = new Date(iso); return date.getHours() * 60 + date.getMinutes(); };
const key = (event: Pick<CalendarEvent, "account" | "calendarId">) => `${event.account}|${event.calendarId}`;
/** In the grid: a timed event within one day. The rest (all-day, across midnight) go in the row above it. */
const inGrid = (event: CalendarEvent) => !event.allDay && !!event.start && event.startDate === event.endDate;

/** Side by side when they overlap: each event's lane and how many lanes its cluster needs. */
function lanes(events: CalendarEvent[]): Array<{ event: CalendarEvent; lane: number; of: number }> {
  const sorted = [...events].sort((a, b) => a.start!.localeCompare(b.start!) || b.end!.localeCompare(a.end!));
  const placed: Array<{ event: CalendarEvent; lane: number; of: number }> = [];
  let cluster: typeof placed = [], ends: string[] = [], clusterEnd = "";
  const close = () => { for (const item of cluster) item.of = ends.length; cluster = []; ends = []; };
  for (const event of sorted) {
    if (cluster.length && event.start! >= clusterEnd) close();
    let lane = ends.findIndex((end) => end <= event.start!);
    if (lane < 0) { lane = ends.length; ends.push(event.end!); } else ends[lane] = event.end!;
    clusterEnd = cluster.length ? (event.end! > clusterEnd ? event.end! : clusterEnd) : event.end!;
    const item = { event, lane, of: 1 };
    cluster.push(item);
    placed.push(item);
  }
  close();
  return placed;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  return now;
}

function EventCard({ event, onClose }: { event: CalendarEvent; onClose(): void }) {
  const when = event.allDay || !event.start
    ? `${event.startDate}${event.endDate !== event.startDate ? ` – ${event.endDate}` : ""} · ${t("cal.allDay")}`
    : `${parse(event.startDate).toLocaleDateString(intlLocale(), { weekday: "short", month: "short", day: "numeric" })} ${hhmm(event.start)} – ${hhmm(event.end!)}`;
  return (
    <div className="ev-card" data-k={event.k} role="dialog" aria-label={event.title}>
      <div className="ev-card-head">
        <b>{event.title}</b>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>×</button>
      </div>
      <p>{when}</p>
      {event.location && <p>{event.location}</p>}
      <p className="quiet">
        {event.calendar}
        {event.attendees > 1 && ` · ${t("cal.attendees", { n: event.attendees })}`}
        {event.response === "declined" && ` · ${t("cal.declined")}`}
        {event.response === "needsAction" && ` · ${t("cal.unanswered")}`}
      </p>
      <p className="ev-card-links">
        {event.meeting && <a href={event.meeting} target="_blank" rel="noreferrer noopener">{t("cal.join")}</a>}
        {event.link && <a href={event.link} target="_blank" rel="noreferrer noopener">{t("cal.open")}</a>}
      </p>
    </div>
  );
}

/** The calendar page: the user's Google Calendar, a week at a time. */
export function Calendar({ snapshot }: { snapshot: CalendarSnapshot | undefined }) {
  const today = snapshot?.today ?? ymd(new Date());
  const [week, setWeek] = useState(() => mondayOf(today));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<CalendarEvent | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const now = useNow();
  const sources = snapshot?.sources ?? [];
  const calendars = sources.flatMap((source) => source.calendars.map((calendar) => ({ ...calendar, account: source.account, key: `${source.account}|${calendar.id}` })));

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(week, index)), [week]);
  const last = days[6];
  const shown = (snapshot?.events ?? []).filter((event) => !hidden.has(key(event)) && event.endDate >= week && event.startDate <= last);
  const timed = shown.filter(inGrid);
  const banner = shown.filter((event) => !inGrid(event));
  // The hours shown: 8 to 20, stretched to what this week holds.
  const from = Math.min(8, ...timed.map((event) => Math.floor(minutesOf(event.start!) / 60)));
  const to = Math.max(20, ...timed.map((event) => Math.ceil((minutesOf(event.end!) || 24 * 60) / 60)));
  const hours = Array.from({ length: to - from }, (_, index) => from + index);

  // Open on the morning, or on now when it is later.
  useEffect(() => {
    const at = week === mondayOf(today) ? Math.max(from, new Date().getHours() - 1) : Math.max(from, 8);
    if (scroller.current) scroller.current.scrollTop = (at - from) * HOUR;
  }, [week, from, today]);

  const label = (day: string, options: Intl.DateTimeFormatOptions) => parse(day).toLocaleDateString(intlLocale(), options);
  const toggle = (calendar: string) => setHidden((current) => { const next = new Set(current); if (!next.delete(calendar)) next.add(calendar); return next; });
  const nowDate = new Date(now);
  const nowTop = ((nowDate.getHours() - from) * 60 + nowDate.getMinutes()) / 60 * HOUR;

  return (
    <section className="calendar" aria-label={t("page.calendar")}>
      <SourceBar module="calendar" sources={sources} notConnected={t("src.notConnected.cal")} />
      <div className="cal-bar">
        <div className="cal-nav">
          <button type="button" className="icon-btn" onClick={() => setWeek(addDays(week, -7))} aria-label={t("cal.prev")}>‹</button>
          <button type="button" className="ghost small" disabled={week === mondayOf(today)} onClick={() => setWeek(mondayOf(today))}>{t("cal.thisWeek")}</button>
          <button type="button" className="icon-btn" onClick={() => setWeek(addDays(week, 7))} aria-label={t("cal.next")}>›</button>
          <b>{t("cal.week", { from: label(week, { month: "short", day: "numeric" }), to: label(last, { month: "short", day: "numeric" }) })}</b>
        </div>
        {calendars.length > 1 && (
          <div className="chips cal-legend" role="group">
            {calendars.map((calendar) => (
              <button type="button" key={calendar.key} className="chip" data-off={hidden.has(calendar.key) || undefined} aria-pressed={!hidden.has(calendar.key)}
                onClick={() => toggle(calendar.key)} title={t("cal.hide", { name: calendar.name })}>
                <span className="mark" data-k={calendar.varied ? undefined : calendar.k} data-varied={calendar.varied || undefined} />{calendar.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {picked && <EventCard event={picked} onClose={() => setPicked(null)} />}

      <div className="week-grid" ref={scroller}>
        <div className="wk-top">
        <div className="wk-head">
          <span />
          {days.map((day) => (
            <div key={day} className="wk-day" data-today={day === today || undefined} data-weekend={parse(day).getDay() % 6 === 0 || undefined}>
              {label(day, { weekday: "short" })}<b>{parse(day).getDate()}</b>
            </div>
          ))}
        </div>
        {banner.length > 0 && (
          <div className="wk-allday">
            <span>{t("cal.allDay")}</span>
            {days.map((day) => (
              <div key={day}>
                {banner.filter((event) => event.startDate <= day && event.endDate >= day).map((event) => (
                  <button type="button" key={event.id} className="ev ev-chip" data-k={event.k} data-declined={event.response === "declined" || undefined} onClick={() => setPicked(event)}>{event.title}</button>
                ))}
              </div>
            ))}
          </div>
        )}
        </div>
        <div className="wk-body" style={{ height: hours.length * HOUR }}>
          <div className="wk-gutter">{hours.map((hour) => <div key={hour}>{pad(hour)}:00</div>)}</div>
          {days.map((day) => (
            <div key={day} className="wk-col" data-today={day === today || undefined} data-weekend={parse(day).getDay() % 6 === 0 || undefined}>
              {lanes(timed.filter((event) => event.startDate === day)).map(({ event, lane, of }) => {
                const top = (minutesOf(event.start!) - from * 60) / 60 * HOUR;
                const height = Math.max(18, (Date.parse(event.end!) - Date.parse(event.start!)) / 3_600_000 * HOUR - 2);
                return (
                  <button type="button" key={event.id} className="ev" data-k={event.k} data-past={Date.parse(event.end!) < now || undefined}
                    data-declined={event.response === "declined" || undefined} onClick={() => setPicked(event)}
                    style={{ top, height, left: `calc(${(lane / of) * 100}% + 2px)`, width: `calc(${100 / of}% - 4px)` }}>
                    {event.title}<small>{hhmm(event.start!)}{event.location ? ` · ${event.location}` : ""}</small>
                  </button>
                );
              })}
              {day === today && nowTop >= 0 && nowTop <= hours.length * HOUR && <div className="wk-now" style={{ top: nowTop }} />}
            </div>
          ))}
        </div>
      </div>

      {/* Narrow screens: the week as a list of days. */}
      <ol className="agenda">
        {days.map((day) => {
          const todays = shown.filter((event) => event.startDate <= day && event.endDate >= day);
          return (
            <li key={day} data-today={day === today || undefined}>
              <h3>{label(day, { weekday: "short", month: "short", day: "numeric" })}</h3>
              {todays.length === 0 ? <p className="quiet small">—</p> : todays.map((event) => (
                <button type="button" key={event.id} className="agenda-ev" data-k={event.k} data-declined={event.response === "declined" || undefined} onClick={() => setPicked(event)}>
                  <span className="mark" data-k={event.k} />
                  <time>{inGrid(event) ? hhmm(event.start!) : t("cal.allDay")}</time>
                  <span>{event.title}</span>
                </button>
              ))}
            </li>
          );
        })}
      </ol>
      {sources.length > 0 && shown.length === 0 && <p className="quiet empty-list">{t("cal.empty")}</p>}
    </section>
  );
}
