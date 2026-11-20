/** What devices get from the calendar module (StateResponse.modules.calendar). */
export interface CalendarEvent {
  /** `<calendar id>:<event id>`, unique within an account. */
  id: string;
  account: string;
  calendarId: string;
  calendar: string;
  title: string;
  allDay: boolean;
  /** Local dates, inclusive: the days the event covers. */
  startDate: string;
  endDate: string;
  /** Instants (ISO), for events with a time. */
  start?: string;
  end?: string;
  location?: string;
  /** The event in Google Calendar, and its video call, if any. */
  link?: string;
  meeting?: string;
  organizer?: string;
  /** The user's own answer to an invitation. */
  response?: "accepted" | "declined" | "tentative" | "needsAction";
  attendees: number;
  /** Its colour slot (tokens.css `data-k`): its series' own in one of the user's calendars, else its calendar's. */
  k: string;
  /** Alfred may propose moving it: the user organizes it, in a calendar they may change. */
  editable: boolean;
  /** An invitation the user can answer. */
  invited: boolean;
  /** One time of an event that repeats: what names the repeating event, the same for all its times. (Not the
   * colour's "series", which is events of one title.) */
  recurring?: string;
}

/** One connected account's calendars, and how its last read went. */
export interface CalendarSource {
  account: string;
  syncedAt: string | null;
  error: string | null;
  /** The account must be connected again in Settings. */
  reconnect: boolean;
  /** The user let Alfred change this account's calendar (Settings: 日历：替你加和改). */
  canWrite: boolean;
  /** `varied`: one of the user's own, whose events are coloured series by series; the others are all `k`. */
  calendars: Array<{ id: string; name: string; k: string; writable: boolean; varied: boolean }>;
}

export interface CalendarSnapshot {
  /** The home node's local date. */
  today: string;
  /** From a week ago to five weeks ahead, by start. */
  events: CalendarEvent[];
  /** Empty until a Google account with calendar access is connected. */
  sources: CalendarSource[];
}
