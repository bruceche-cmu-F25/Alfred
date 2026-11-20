import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { CalendarEvent, CalendarPending, CalendarSnapshot, CalendarSource, CalendarWhen } from "@alfred/module-calendar/types";
import { api } from "./api.ts";
import { Linked, OutLink } from "./Linked.tsx";
import { SourceBar } from "./SourceBar.tsx";
import { intlLocale, t, type Key } from "./i18n/index.ts";
import { Icon } from "./shell/icons.tsx";

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
const same = (a: Pick<CalendarEvent, "account" | "id">, b: Pick<CalendarEvent, "account" | "id">) => a.account === b.account && a.id === b.id;
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
const minutesIn = (time: string) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };
const dayDiff = (from: string, to: string) => Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
const instant = (day: string, time: string) => { const date = parse(day); date.setHours(0, minutesIn(time)); return date; };

/** An event as the page draws it: one of the mirror's, one on its way to Google, or the one being typed. */
type Shown = CalendarEvent & { pending?: boolean; draft?: boolean };

/** When an event is, as the fields of an event. */
const whenFields = (when: CalendarWhen) => "date" in when
  ? { allDay: true, startDate: when.date, endDate: when.endDate, start: undefined, end: undefined }
  : { allDay: false, start: when.start, end: when.end, startDate: ymd(new Date(when.start)), endDate: ymd(new Date(Math.max(Date.parse(when.start), Date.parse(when.end) - 1))) };

/** The mirror's events with the changes Google has not answered yet laid over them. */
function withPending(events: CalendarEvent[], pending: CalendarPending[], sources: CalendarSource[]): Shown[] {
  if (!pending.length) return events;
  const shown: Shown[] = [...events];
  for (const change of pending) {
    if (change.removed) { const at = shown.findIndex((event) => same(event, change)); if (at >= 0) shown.splice(at, 1); continue; }
    const fields = {
      ...(change.title !== undefined ? { title: change.title } : {}), ...(change.location !== undefined ? { location: change.location || undefined } : {}),
      ...(change.when ? whenFields(change.when) : {}), ...(change.k ? { k: change.k } : {}), pending: true,
    };
    const index = shown.findIndex((event) => same(event, change));
    if (index >= 0) shown[index] = { ...shown[index], ...fields };
    else if (change.added && change.when) {
      const calendar = sources.find((source) => source.account === change.account)?.calendars.find((candidate) => candidate.id === change.calendarId);
      shown.push({ id: change.id, account: change.account, calendarId: change.calendarId, calendar: calendar?.name ?? "", title: "", attendees: 0, k: calendar?.k ?? "gray", editable: false, invited: false, ...whenFields(change.when), ...fields });
    }
  }
  return shown;
}

/** An event being typed: a new one, or one of the user's being changed. Times are the fields' own text. */
interface Draft {
  event?: CalendarEvent;
  account: string;
  calendarId: string;
  title: string;
  allDay: boolean;
  /** The first day; `endDate` is the last day of a whole-day event. */
  date: string;
  endDate: string;
  start: string;
  end: string;
  /** The days a timed event runs past its first, when that is more than an end after midnight (rare; kept as it is). */
  span: number;
  location: string;
  /** Null while an event's notes have not been read: then they are left alone. `notesWere`: as they were read. */
  notes: string | null;
  notesWere: string;
}

function draftOf(event: CalendarEvent): Draft {
  const timed = !event.allDay && !!event.start;
  const start = timed ? hhmm(event.start!) : "09:00", end = timed ? hhmm(event.end!) : "10:00";
  const days = timed ? dayDiff(event.startDate, ymd(new Date(event.end!))) : 0;
  return {
    event, account: event.account, calendarId: event.calendarId, title: event.title, allDay: !timed, date: event.startDate, endDate: event.endDate,
    start, end, span: days === 1 && end <= start ? 0 : days, location: event.location ?? "", notes: null, notesWere: "",
  };
}

/** Null while the fields do not make an event (a time half typed). An end at or before the start is the next day's. */
function draftWhen(draft: Draft): CalendarWhen | null {
  if (!draft.date) return null;
  if (draft.allDay) return { date: draft.date, endDate: draft.endDate >= draft.date ? draft.endDate : draft.date };
  if (!/^\d\d:\d\d$/.test(draft.start) || !/^\d\d:\d\d$/.test(draft.end)) return null;
  const start = instant(draft.date, draft.start), end = instant(addDays(draft.date, draft.span || (draft.end <= draft.start ? 1 : 0)), draft.end);
  return end > start ? { start: start.toISOString(), end: end.toISOString() } : null;
}

const eventWhen = (event: CalendarEvent): CalendarWhen => event.allDay || !event.start ? { date: event.startDate, endDate: event.endDate } : { start: event.start, end: event.end! };
const sameWhen = (a: CalendarWhen, b: CalendarWhen) => "date" in a
  ? "date" in b && a.date === b.date && a.endDate === b.endDate
  : !("date" in b) && Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);

/** A calendar the user may add to. */
interface Target { account: string; id: string; name: string; k: string }
/** In the grid: a timed event within one day. The rest (all-day, across midnight) go in the row above it. */
const inGrid = (event: CalendarEvent) => !event.allDay && !!event.start && event.startDate === event.endDate;

/** Side by side when they overlap: each event's lane and how many lanes its cluster needs. */
function lanes<E extends CalendarEvent>(events: E[]): Array<{ event: E; lane: number; of: number }> {
  const sorted = [...events].sort((a, b) => a.start!.localeCompare(b.start!) || b.end!.localeCompare(a.end!));
  const placed: Array<{ event: E; lane: number; of: number }> = [];
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

const whenText = (event: CalendarEvent) => event.allDay || !event.start
  ? `${event.startDate}${event.endDate !== event.startDate ? ` – ${event.endDate}` : ""} · ${t("cal.allDay")}`
  : `${parse(event.startDate).toLocaleDateString(intlLocale(), { weekday: "short", month: "short", day: "numeric" })} ${hhmm(event.start)} – ${hhmm(event.end!)}`;

function EventCard({ event, onClose, onEdit, onDelete }: { event: Shown; onClose(): void; onEdit?: () => void; onDelete?: () => void }) {
  const when = whenText(event);
  return (
    <div className="ev-card" data-k={event.k} role="dialog" aria-label={event.title}>
      <div className="ev-card-head">
        <b>{event.title}</b>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>×</button>
      </div>
      <p>{when}</p>
      {event.location && <p><Linked text={event.location} /></p>}
      <p className="quiet">
        {event.calendar}
        {event.attendees > 1 && ` · ${t("cal.attendees", { n: event.attendees })}`}
        {event.response === "declined" && ` · ${t("cal.declined")}`}
        {event.response === "needsAction" && ` · ${t("cal.unanswered")}`}
      </p>
      <p className="ev-card-links">
        {onEdit && <button type="button" className="link" onClick={onEdit}>{t("cal.edit")}</button>}
        {onDelete && <button type="button" className="link" onClick={onDelete}>{t("cal.delete")}</button>}
        {event.meeting && <OutLink href={event.meeting}>{t("cal.join")}</OutLink>}
        {event.link && <OutLink href={event.link}>{t("cal.open")}</OutLink>}
        {event.pending && <span className="quiet">{t("cal.pending")}</span>}
      </p>
    </div>
  );
}

/** Deleting an event cannot be taken back from here, so it is asked once, in the same kind of card over the page:
 * what goes, when it was, and who hears of it. */
function DeleteAsk({ event, onClose, onDeleted }: { event: CalendarEvent; onClose(): void; onDeleted(change: CalendarPending): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    setBusy(true);
    setError(null);
    api.op("calendar.delete", { account: event.account, id: event.id }).then((response) => {
      const result = response.result as { error?: string };
      if (result.error && result.error !== "gone") return setError(t(`cal.err.${result.error}` as Key));
      onDeleted({ id: event.id, account: event.account, calendarId: event.calendarId, added: false, removed: true });
      onClose();
    }).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const hint = event.attendees > 1 ? t("cal.tellsGuests", { n: event.attendees - 1 }) : event.recurring ? t("cal.deleteOne") : "";
  return createPortal(
    <div className="ev-pop" role="presentation" onMouseDown={(down) => { if (down.target === down.currentTarget) onClose(); }}>
      <div className="ev-edit ev-ask" data-k={event.k} role="alertdialog" aria-modal="true" aria-label={t("cal.deleteAsk", { title: event.title })}
        onKeyDown={(press) => { if (press.key === "Escape") onClose(); }}>
        <b>{t("cal.deleteAsk", { title: event.title })}</b>
        <p>{whenText(event)}{hint && ` · ${hint}`}</p>
        <div className="ev-foot">
          <span className={error ? "ev-error" : undefined} role={error ? "alert" : undefined}>{error}</span>
          <button type="button" className="ghost" onClick={onClose} autoFocus>{t("common.cancel")}</button>
          <button type="button" className="danger" disabled={busy} onClick={remove}>{t(busy ? "cal.deleting" : "cal.delete")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The event being typed, in a card over the page (the page behind it is blurred): its title, when it is, where it
 * goes, and Save. Saving is the user's yes: it goes to Google with no proposal in between, and `onSaved` gets what to
 * draw until Google answers. Escape, or a click beside the card, puts it away. */
function EventEditor({ draft, targets, k, range, onChange, onClose, onSaved, onDelete }: {
  draft: Draft; targets: Target[]; k: string; range: { from: string; to: string };
  onChange(next: Draft): void; onClose(): void; onSaved(change: CalendarPending): void; onDelete?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const event = draft.event;
  const when = draftWhen(draft);
  const set = (fields: Partial<Draft>) => { setError(null); onChange({ ...draft, ...fields }); };
  /** Moving the start keeps the length. */
  const setStart = (start: string) => {
    if (!/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(draft.start) || !/^\d\d:\d\d$/.test(draft.end)) return set({ start });
    const length = (minutesIn(draft.end) - minutesIn(draft.start) + 1440) % 1440 || 60;
    set({ start, end: clock((minutesIn(start) + length) % 1440) });
  };
  const setDate = (date: string) => set({ date, endDate: date && draft.date && draft.endDate >= draft.date ? addDays(date, dayDiff(draft.date, draft.endDate)) : date });
  const wraps = !draft.allDay && !draft.span && !!when && draft.end <= draft.start;

  const save = (submit?: FormEvent) => {
    submit?.preventDefault();
    const title = draft.title.trim(), location = draft.location.trim(), notes = draft.notes?.trim();
    if (!when || !title || saving) return;
    let op: string, input: Record<string, unknown>, change: CalendarPending;
    if (event) {
      const changes = {
        ...(title !== event.title ? { title } : {}), ...(sameWhen(when, eventWhen(event)) ? {} : { when }),
        ...(location !== (event.location ?? "") ? { location } : {}), ...(notes !== undefined && notes !== draft.notesWere.trim() ? { notes } : {}),
      };
      if (!Object.keys(changes).length) return onClose();
      op = "calendar.edit";
      input = { account: event.account, id: event.id, ...changes };
      change = { id: event.id, account: event.account, calendarId: event.calendarId, added: false, ...changes };
    } else {
      op = "calendar.create";
      input = { account: draft.account, calendarId: draft.calendarId, title, when, ...(location ? { location } : {}), ...(notes ? { notes } : {}) };
      change = { id: "", account: draft.account, calendarId: draft.calendarId, added: true, title, when, ...(location ? { location } : {}) };
    }
    setSaving(true);
    setError(null);
    api.op(op, input).then((response) => {
      const result = response.result as { id?: string; k?: string; error?: string };
      if (result.error && result.error !== "nothing") return setError(t(`cal.err.${result.error}` as Key));
      if (!result.error) onSaved({ ...change, id: result.id ?? change.id, ...(result.k ? { k: result.k } : {}) });
      onClose();
    }).catch((reason: Error) => setError(reason.message)).finally(() => setSaving(false));
  };

  const hint = event && event.attendees > 1 ? t("cal.tellsGuests", { n: event.attendees - 1 }) : event?.recurring ? t("cal.onlyThis") : "";
  return createPortal(
    <div className="ev-pop" role="presentation" onMouseDown={(down) => { if (down.target === down.currentTarget) onClose(); }}>
    <form className="ev-edit" data-k={k} role="dialog" aria-modal="true" aria-label={t(event ? "cal.edit" : "cal.newEvent")} onSubmit={save}
      onKeyDown={(press) => { if (press.nativeEvent.isComposing) return; if (press.key === "Escape") onClose(); else if (press.key === "Enter" && (press.metaKey || press.ctrlKey)) save(); }}>
      <div className="ev-card-head">
        <input className="ev-title" value={draft.title} onChange={(change) => set({ title: change.target.value })} placeholder={t("cal.title")} aria-label={t("cal.title")} maxLength={300} autoFocus />
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>×</button>
      </div>
      <div className="ev-when">
        <input type="date" value={draft.date} min={event ? undefined : range.from} max={event ? undefined : range.to} onChange={(change) => setDate(change.target.value)} aria-label={t("cal.date")} required />
        {draft.allDay ? (
          <><span>–</span><input type="date" value={draft.endDate} min={draft.date} onChange={(change) => set({ endDate: change.target.value })} aria-label={t("cal.endDate")} required /></>
        ) : (
          <>
            <span className="ev-times">
              <input type="time" value={draft.start} onChange={(change) => setStart(change.target.value)} aria-label={t("cal.start")} required />
              <span>–</span>
              <input type="time" value={draft.end} onChange={(change) => set({ end: change.target.value })} aria-label={t("cal.end")} required />
            </span>
            {wraps && <span className="quiet">{t("cal.nextDay")}</span>}
            {draft.span > 0 && <span className="quiet">{t("cal.plusDays", { n: draft.span })}</span>}
          </>
        )}
        <label className="ev-allday"><input type="checkbox" aria-label={t("cal.allDay")} checked={draft.allDay} onChange={(change) => set({ allDay: change.target.checked, span: 0, endDate: draft.endDate >= draft.date ? draft.endDate : draft.date })} />{t("cal.allDay")}</label>
      </div>
      {!event && targets.length > 1 && (
        <select className="ev-field" value={`${draft.account}|${draft.calendarId}`} aria-label={t("cal.calendar")}
          onChange={(change) => { const target = targets.find((candidate) => key({ account: candidate.account, calendarId: candidate.id }) === change.target.value); if (target) set({ account: target.account, calendarId: target.id }); }}>
          {targets.map((target) => <option key={`${target.account}|${target.id}`} value={`${target.account}|${target.id}`}>{target.name}{targets.some((other) => other.account !== target.account) ? ` · ${target.account}` : ""}</option>)}
        </select>
      )}
      <input className="ev-field" value={draft.location} onChange={(change) => set({ location: change.target.value })} placeholder={t("cal.location")} aria-label={t("cal.location")} maxLength={300} />
      <textarea className="ev-field" rows={2} value={draft.notes ?? ""} disabled={draft.notes === null} onChange={(change) => set({ notes: change.target.value })} placeholder={t("cal.notes")} aria-label={t("cal.notes")} maxLength={4000} />
      <div className="ev-foot">
        {onDelete && <button type="button" className="ghost ev-delete" onClick={onDelete}>{t("cal.delete")}</button>}
        <span className={error ? "ev-error" : "quiet"} role={error ? "alert" : undefined}>{error ?? hint}</span>
        <button type="button" className="ghost" onClick={onClose}>{t("common.cancel")}</button>
        <button type="submit" disabled={!when || !draft.title.trim() || saving}>{t(saving ? "cal.saving" : "cal.save")}</button>
      </div>
    </form>
    </div>,
    document.body,
  );
}

/** The calendars this device has hidden: remembered, since the card that shows them is closed most of the time. */
const HIDDEN_KEY = "alfred.calendar.hidden";
function savedHidden(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch { return new Set(); }
}

/** At most this many colour dots on the button; the card has every calendar. */
const DOTS = 4;

/** Which calendars are shown. They are set once and then left alone, so they are not a row of the page: a small
 * button at the end of the source's row (their colours, and how many are on when some are off), and a card of them
 * under it. */
function CalendarPicker({ sources, hidden, onToggle }: { sources: CalendarSource[]; hidden: ReadonlySet<string>; onToggle(key: string): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const all = sources.flatMap((source) => source.calendars.map((calendar) => ({ ...calendar, key: `${source.account}|${calendar.id}` })));
  const on = all.filter((calendar) => !hidden.has(calendar.key)).length;
  const mark = (calendar: (typeof all)[number]) => (
    <span key={calendar.key} className={hidden.has(calendar.key) ? "mark dim" : "mark"} data-k={calendar.varied ? undefined : calendar.k} data-varied={calendar.varied || undefined} />
  );
  return (
    <div className="cal-pick" ref={root}>
      <button type="button" className="cal-pick-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`${t("cal.calendars")} ${on}/${all.length}`} onClick={() => setOpen(!open)}>
        <span className="cal-dots">{all.slice(0, DOTS).map(mark)}</span>
        <span className="cal-pick-name">{t("cal.calendars")}</span>
        {on < all.length && <span className="count">{on}/{all.length}</span>}
        <Icon name="down" />
      </button>
      {open && (
        <div className="cal-card" role="menu" aria-label={t("cal.calendars")}>
          {sources.map((source) => (
            <div key={source.account} role="group" aria-label={source.account}>
              {sources.length > 1 && <p className="cal-card-label">{source.account}</p>}
              {source.calendars.map((calendar) => {
                const item = { ...calendar, key: `${source.account}|${calendar.id}` };
                return (
                  <button type="button" key={item.key} role="menuitemcheckbox" aria-checked={!hidden.has(item.key)} onClick={() => onToggle(item.key)} title={t("cal.hide", { name: calendar.name })}>
                    {mark(item)}<span>{calendar.name}</span><Icon name="check" />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The calendar page: the user's Google Calendar, a week at a time. */
export function Calendar({ snapshot }: { snapshot: CalendarSnapshot | undefined }) {
  const today = snapshot?.today ?? ymd(new Date());
  const [week, setWeek] = useState(() => mondayOf(today));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(savedHidden);
  const [picked, setPicked] = useState<Pick<CalendarEvent, "account" | "id"> | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** What was just saved, drawn until the next snapshot (which has it: on its way, or already Google's). */
  const [sent, setSent] = useState<CalendarPending[]>([]);
  const [noWrite, setNoWrite] = useState(false);
  /** The event the user is being asked about deleting. */
  const [removing, setRemoving] = useState<CalendarEvent | null>(null);
  /** While a new event is being dragged out on the grid: its day and minutes. */
  const [stretch, setStretch] = useState<{ day: string; from: number; to: number } | null>(null);
  const press = useRef<{ day: string; at: number; byMouse: boolean } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const now = useNow();
  const sources = snapshot?.sources ?? [];
  const calendarCount = sources.reduce((sum, source) => sum + source.calendars.length, 0);
  useEffect(() => setSent([]), [snapshot]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(week, index)), [week]);
  const last = days[6];
  /** Where a new event may go: the calendars the user may change, their main one first. And when: the days the mirror
   * holds, since an event outside them would not be seen again here. */
  const targets: Target[] = sources.flatMap((source) => source.canWrite ? source.calendars.filter((calendar) => calendar.writable).map((calendar) => ({ account: source.account, id: calendar.id, name: calendar.name, k: calendar.k })) : []);
  const range = { from: snapshot?.from ?? addDays(today, -7), to: snapshot?.to ?? addDays(today, 35) };
  const inRange = (day: string) => day >= range.from && day <= range.to;
  const outside = week > range.to || last < range.from;

  const events = useMemo(() => withPending(snapshot?.events ?? [], [...(snapshot?.pending ?? []), ...sent], sources), [snapshot, sent]);
  const pickedEvent = picked ? events.find((event) => same(event, picked)) ?? null : null;
  const draftWhenNow = draft ? draftWhen(draft) : null;
  const draftTarget = draft && targets.find((target) => target.account === draft.account && target.id === draft.calendarId);
  const draftK = draft?.event?.k ?? draftTarget?.k ?? "gray";
  const drawn: Shown[] = draft && draftWhenNow
    ? [...events.filter((event) => !draft.event || !same(event, draft.event)), {
        ...(draft.event ?? { id: "draft", account: draft.account, calendarId: draft.calendarId, calendar: draftTarget?.name ?? "", attendees: 0, k: draftK, editable: false, invited: false }),
        title: draft.title.trim() || t("cal.newEvent"), location: draft.location.trim() || undefined, ...whenFields(draftWhenNow), draft: true,
      }]
    : events;
  const shown = drawn.filter((event) => (event.draft || !hidden.has(key(event))) && event.endDate >= week && event.startDate <= last)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || Number(inGrid(a)) - Number(inGrid(b)) || (a.start ?? "").localeCompare(b.start ?? ""));
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
  const toggle = (calendar: string) => setHidden((current) => {
    const next = new Set(current);
    if (!next.delete(calendar)) next.add(calendar);
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])); } catch { /* this view only */ }
    return next;
  });
  const nowDate = new Date(now);
  const nowTop = ((nowDate.getHours() - from) * 60 + nowDate.getMinutes()) / 60 * HOUR;

  const open = (event: Shown) => { if (event.draft) return; setDraft(null); setNoWrite(false); setPicked({ account: event.account, id: event.id }); };
  const edit = (event: CalendarEvent) => { setPicked(null); setDraft(draftOf(event)); };
  const askDelete = (event: CalendarEvent) => { setDraft(null); setRemoving(event); };
  const sentOne = (change: CalendarPending) => setSent((current) => [...current, change]);
  /** A new event on `day` from minute `at` to `until`. One already being typed is put there instead: placing it is
   * part of typing it. An event being changed stays where its fields say. */
  const place = (day: string, at: number, until: number) => {
    if (!targets.length) return setNoWrite(sources.length > 0);
    if (!inRange(day) || draft?.event) return;
    const time = { allDay: false, date: day, endDate: day, start: clock(at), end: clock(until), span: 0 };
    setPicked(null);
    setDraft(draft ? { ...draft, ...time } : { account: targets[0].account, calendarId: targets[0].id, title: "", location: "", notes: "", notesWere: "", ...time });
  };
  /** From the button, or a day of the list: the coming hour today, nine on another day. */
  const add = (day?: string) => {
    const on = day ?? (today >= week && today <= last ? today : days.find(inRange) ?? today);
    const at = on === today ? Math.min(23, new Date().getHours() + 1) * 60 : 9 * 60;
    place(on, at, at + 60);
  };

  // An event's notes are read when it is opened to be changed; until then (or if they cannot be) they are left alone.
  const editing = draft?.event;
  useEffect(() => {
    if (!editing) return;
    let live = true;
    api.query<{ notes?: string }>("calendar.event", { account: editing.account, id: editing.id }).then((answer) => {
      if (live && typeof answer.notes === "string") setDraft((current) => current?.event && same(current.event, editing) && current.notes === null ? { ...current, notes: answer.notes!, notesWere: answer.notes! } : current);
    }).catch(() => {});
    return () => { live = false; };
  }, [editing?.account, editing?.id]);

  // On the grid: a click on an empty hour starts an hour-long event there; with a mouse, dragging sets its length.
  const minuteAt = (column: HTMLElement, y: number) => Math.max(from * 60, Math.min(to * 60, from * 60 + (y - column.getBoundingClientRect().top) / HOUR * 60));
  const snap = (minute: number) => Math.round(minute / 15) * 15;
  const span = (anchor: number, minute: number): [number, number] => Math.abs(snap(minute) - snap(anchor)) < 15
    ? [Math.floor(anchor / 30) * 30, Math.min(24 * 60, Math.floor(anchor / 30) * 30 + 60)]
    : [Math.min(snap(anchor), snap(minute)), Math.max(snap(anchor), snap(minute))];
  const grid = (day: string) => ({
    onPointerDown(down: ReactPointerEvent<HTMLDivElement>) {
      if (down.button !== 0 || down.target !== down.currentTarget) return;
      const byMouse = down.pointerType === "mouse";
      press.current = { day, at: minuteAt(down.currentTarget, down.clientY), byMouse };
      if (byMouse && targets.length && inRange(day) && !draft?.event) down.currentTarget.setPointerCapture(down.pointerId);
    },
    onPointerMove(move: ReactPointerEvent<HTMLDivElement>) {
      const held = press.current;
      if (!held?.byMouse || held.day !== day || !move.currentTarget.hasPointerCapture(move.pointerId)) return;
      const [a, b] = span(held.at, minuteAt(move.currentTarget, move.clientY));
      if (stretch || Math.abs(snap(minuteAt(move.currentTarget, move.clientY)) - snap(held.at)) >= 15) setStretch({ day, from: a, to: b });
    },
    onPointerUp(up: ReactPointerEvent<HTMLDivElement>) {
      const held = press.current;
      press.current = null;
      setStretch(null);
      if (!held || held.day !== day || up.target !== up.currentTarget) return;
      const [a, b] = span(held.at, held.byMouse ? minuteAt(up.currentTarget, up.clientY) : held.at);
      place(day, a, b);
    },
    onPointerCancel() { press.current = null; setStretch(null); },
  });

  return (
    <section className="calendar" aria-label={t("page.calendar")}>
      <SourceBar module="calendar" mark="google-calendar" sources={sources} notConnected={t("src.notConnected.cal")}>
        {calendarCount > 1 && <CalendarPicker sources={sources} hidden={hidden} onToggle={toggle} />}
      </SourceBar>
      <div className="cal-bar">
        <div className="cal-nav">
          <button type="button" className="icon-btn" onClick={() => setWeek(addDays(week, -7))} aria-label={t("cal.prev")}>‹</button>
          <button type="button" className="ghost small" disabled={week === mondayOf(today)} onClick={() => setWeek(mondayOf(today))}>{t("cal.thisWeek")}</button>
          <button type="button" className="icon-btn" onClick={() => setWeek(addDays(week, 7))} aria-label={t("cal.next")}>›</button>
          <b>{t("cal.week", { from: label(week, { month: "short", day: "numeric" }), to: label(last, { month: "short", day: "numeric" }) })}</b>
        </div>
        {sources.length > 0 && <button type="button" className="cal-add" disabled={outside || !!draft?.event} onClick={() => add()} aria-label={t("cal.newEvent")}><Icon name="plus" /><span>{t("cal.new")}</span></button>}
      </div>
      {noWrite && !targets.length && <p className="cal-note"><span>{t("cal.noWrite")}</span><a href="#p=core.settings">{t("cal.noWrite.go")}</a></p>}
      {pickedEvent && !draft && <EventCard event={pickedEvent} onClose={() => setPicked(null)}
        onEdit={pickedEvent.editable && !pickedEvent.pending ? () => edit(pickedEvent) : undefined} onDelete={pickedEvent.editable && !pickedEvent.pending ? () => askDelete(pickedEvent) : undefined} />}
      {draft && <EventEditor draft={draft} targets={targets} k={draftK} range={range} onChange={setDraft} onClose={() => setDraft(null)} onSaved={sentOne}
        onDelete={draft.event ? () => askDelete(draft.event!) : undefined} />}
      {removing && <DeleteAsk event={removing} onClose={() => setRemoving(null)} onDeleted={(change) => { sentOne(change); setPicked(null); }} />}

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
                  <button type="button" key={event.id} className="ev ev-chip" data-k={event.k} data-declined={event.response === "declined" || undefined}
                    data-pending={event.pending || undefined} data-draft={event.draft || undefined} onClick={() => open(event)}>{event.title}</button>
                ))}
              </div>
            ))}
          </div>
        )}
        </div>
        <div className="wk-body" style={{ height: hours.length * HOUR }}>
          <div className="wk-gutter">{hours.map((hour) => <div key={hour}>{pad(hour)}:00</div>)}</div>
          {days.map((day) => (
            <div key={day} className="wk-col" data-today={day === today || undefined} data-weekend={parse(day).getDay() % 6 === 0 || undefined}
              data-open={(targets.length > 0 && inRange(day) && !draft?.event) || undefined} {...grid(day)}>
              {lanes(timed.filter((event) => event.startDate === day)).map(({ event, lane, of }) => {
                const top = (minutesOf(event.start!) - from * 60) / 60 * HOUR;
                const height = Math.max(18, (Date.parse(event.end!) - Date.parse(event.start!)) / 3_600_000 * HOUR - 2);
                return (
                  <button type="button" key={event.id} className="ev" data-k={event.k} data-past={(!event.draft && Date.parse(event.end!) < now) || undefined}
                    data-declined={event.response === "declined" || undefined} data-pending={event.pending || undefined} data-draft={event.draft || undefined}
                    title={event.pending ? t("cal.pending") : undefined} onClick={() => open(event)}
                    style={{ top, height, left: `calc(${(lane / of) * 100}% + 2px)`, width: `calc(${100 / of}% - 4px)` }}>
                    {event.title}<small>{hhmm(event.start!)}{event.draft ? `–${hhmm(event.end!)}` : event.location ? ` · ${event.location}` : ""}</small>
                  </button>
                );
              })}
              {stretch?.day === day && (
                <div className="ev ev-stretch" style={{ top: (stretch.from - from * 60) / 60 * HOUR, height: Math.max(10, (stretch.to - stretch.from) / 60 * HOUR - 2), left: 2, right: 2 }}>
                  <small>{clock(stretch.from)}–{clock(stretch.to)}</small>
                </div>
              )}
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
              <h3>
                {label(day, { weekday: "short", month: "short", day: "numeric" })}
                {targets.length > 0 && inRange(day) && !draft?.event && <button type="button" className="icon-btn" onClick={() => add(day)} aria-label={t("cal.addOn", { day: label(day, { month: "short", day: "numeric" }) })}><Icon name="plus" /></button>}
              </h3>
              {todays.length === 0 ? <p className="quiet small">—</p> : todays.map((event) => (
                <button type="button" key={event.id} className="agenda-ev" data-k={event.k} data-declined={event.response === "declined" || undefined}
                  data-pending={event.pending || undefined} data-draft={event.draft || undefined} onClick={() => open(event)}>
                  <span className="mark" data-k={event.k} />
                  <time>{inGrid(event) ? hhmm(event.start!) : t("cal.allDay")}</time>
                  <span>{event.title}</span>
                </button>
              ))}
            </li>
          );
        })}
      </ol>
      {sources.length > 0 && shown.length === 0 && <p className="quiet empty-list">{t(outside ? "cal.outside" : "cal.empty")}</p>}
    </section>
  );
}
