/** The client protocol, version 1. Every device speaks this and nothing else;
 * the Mac app has no private channel. Types only, so any client can import it.
 *
 * Commands are HTTP POSTs with a request id: a retry with the same id returns
 * the original result, and reusing an id for something else is refused (409).
 * Events are a Server-Sent Events stream ordered by `seq`; reconnecting with
 * `Last-Event-ID` (or `?after=`) replays what was missed.
 *
 *   GET  /api/state                         StateResponse
 *   GET  /api/events?after=<seq>            text/event-stream: `core` events (data: CoreEvent, with ids, replayed
 *                                           after a drop) and `live` updates (data: LiveUpdate, never replayed)
 *   GET  /api/conversations/:id             ConversationDetail
 *   POST /api/conversations/:id             UpdateConversationRequest -> Conversation
 *   POST /api/runs                          SubmitRunRequest -> SubmitRunResponse (202); no conversationId starts one
 *   GET  /api/runs/:id                      RunDetail
 *   POST /api/runs/:id/cancel               -> Run
 *   POST /api/runs/:id/resume               -> Run
 *   POST /api/runs/:id/respond              RespondRequest -> Run (answers the question the run waits on)
 *   POST /api/ops/:op                       OpRequest -> OpResponse
 *   POST /api/notices/:id/(claim|present|acknowledge)   NoticeRequest -> Notice
 *   POST /api/presence                      PresenceRequest -> PresenceResponse
 */
export const PROTOCOL_VERSION = 1;

export type Actor = "user" | "alfred" | "system";

export interface CoreEvent {
  seq: number;
  id: string;
  at: string;
  kind: string;
  subject: string | null;
  runId: string | null;
  actor: Actor | null;
  payload: Record<string, unknown>;
}

export type RunState =
  | "queued" | "running" | "waiting_permission" | "waiting_input"
  | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RunOutcome {
  status: "completed" | "failed" | "cancelled";
  /** The engine's own account; an interpretation, not proof. */
  reply?: string;
  error?: string;
  /** Ids of the events the run actually wrote. */
  receipts: string[];
}

/** What a waiting run asks the user. */
export interface RunRequest {
  id: string;
  /** `permission`: may it do this one action (answer `allow` or `deny`). `input`: a choice or a short answer. */
  kind: "input" | "permission";
  question: string;
  options: string[];
  createdAt: string;
}

export interface Run {
  id: string;
  requestId: string;
  conversationId: string;
  goal: string;
  profile: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  cancelRequested: boolean;
  outcome: RunOutcome | null;
  /** Set while the run waits on the user. */
  request: RunRequest | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Runs queued or in progress. */
  busy: number;
  /** Runs that need the user: a question waiting, or interrupted. */
  attention: number;
  lastGoal: string | null;
}

export interface ConversationDetail {
  conversation: Conversation;
  /** Oldest first. */
  runs: Run[];
  /** Per run: its receipts (the events it wrote). */
  receipts: Record<string, CoreEvent[]>;
  /** Per run: how it went (`run.step`, `run.view`, `run.waiting`, `run.answered`), oldest first. */
  activity: Record<string, CoreEvent[]>;
}

export interface UpdateConversationRequest { title?: string; archived?: boolean }

/** A run's reply as it is being written. Not recorded; the run's outcome is the record. */
export interface LiveUpdate { runId: string; conversationId: string; text: string }

export interface RespondRequest { requestId: string; answer: string }

export type NoticeState = "pending" | "claimed" | "presented" | "acknowledged" | "expired";

export interface Notice {
  id: string;
  eventSeq: number;
  kind: string;
  state: NoticeState;
  createdAt: string;
  updatedAt: string;
  claimedBy: string | null;
  claimUntil: string | null;
  expiresAt: string | null;
  payload: Record<string, unknown>;
}

export interface StateResponse {
  protocol: typeof PROTOCOL_VERSION;
  /** The newest event seq this state reflects. Subscribe to events after it. */
  cursor: number;
  /** Not archived, most recently active first. */
  conversations: Conversation[];
  /** The newest runs across all conversations, newest first. */
  runs: Run[];
  /** What each listed run actually wrote, by run id: its receipts as events. */
  receipts: Record<string, CoreEvent[]>;
  /** Not yet acknowledged, oldest first. A presented notice belongs to the device that presented it. */
  notices: Notice[];
  /** Each module's snapshot, by module id. */
  modules: Record<string, unknown>;
  /** The views devices can open, by module id. */
  views: Record<string, Array<{ id: string; title: string }>>;
}

export interface SubmitRunRequest { requestId: string; goal: string; conversationId?: string }
export interface SubmitRunResponse { run: Run; replayed: boolean }
export interface RunDetail { run: Run; events: CoreEvent[] }

export interface OpRequest { requestId: string; input: unknown }
export interface OpResponse { result: unknown; replayed: boolean }

export interface NoticeRequest { client: string }

/** `active`: the user is using this device. `away`: they left it (screen locked, machine asleep). */
export interface PresenceRequest { client: string; kind: "active" | "away" }
/** A return comes with one `welcome` notice, already claimed by the reporting device. */
export interface PresenceResponse { returned: boolean; notice: Notice | null }

/** The payload of a `welcome` notice: what happened while the user was away. */
export interface AwayDigest {
  since: string;
  awayMs: number;
  runs: { completed: number; failed: number; interrupted: number; goals: string[] };
  changes: Record<string, number>;
  waiting: number;
}

export interface ErrorResponse { error: string; code?: string }
