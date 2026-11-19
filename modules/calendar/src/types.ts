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
  /** The colour slot of its calendar (tokens.css `data-k`). */
  k: string;
}

/** One connected account's calendars, and how its last read went. */
export interface CalendarSource {
  account: string;
  syncedAt: string | null;
  error: string | null;
  /** The account must be connected again in Settings. */
  reconnect: boolean;
  calendars: Array<{ id: string; name: string; k: string }>;
}

export interface CalendarSnapshot {
  /** The home node's local date. */
  today: string;
  /** From a week ago to five weeks ahead, by start. */
  events: CalendarEvent[];
  /** Empty until a Google account with calendar access is connected. */
  sources: CalendarSource[];
}
