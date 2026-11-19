/** The client protocol, version 1. Every device speaks this and nothing else;
 * the Mac app has no private channel. Types only, so any client can import it.
 *
 * Commands are HTTP POSTs with a request id (`requestId` in the body): a retry with the same id returns
 * the original result, and reusing an id for something else is refused (409). A few commands (a session, a
 * conversation's changes, projects, cancel and resume) also take none, from devices that do not send one yet;
 * such a command is done, but a retry of it cannot be told from a second command.
 * Events are a Server-Sent Events stream ordered by `seq`; reconnecting with
 * `Last-Event-ID` (or `?after=`) replays what was missed.
 *
 *   GET  /api/state                         StateResponse
 *   GET  /api/events?after=<seq>            text/event-stream: `core` events (data: CoreEvent, with ids, replayed
 *                                           after a drop) and `live` updates (data: LiveUpdate, never replayed)
 *   GET  /api/conversations/:id             ConversationDetail
 *   POST /api/conversations                 StartSessionRequest -> Conversation (a development session in a trusted project)
 *   POST /api/conversations/:id             UpdateConversationRequest -> Conversation
 *   GET  /api/conversations/:id/changes     SessionChanges (a development session's changed files)
 *   GET  /api/conversations/:id/diff?path=  { diff } (one changed file, against the session's snapshot)
 *   POST /api/runs                          SubmitRunRequest -> SubmitRunResponse (202); no conversationId starts one
 *   GET  /api/runs/:id                      RunDetail
 *   POST /api/runs/:id/cancel               -> Run
 *   POST /api/runs/:id/resume               -> Run
 *   POST /api/runs/:id/respond              RespondRequest -> Run (answers the question the run waits on)
 *   POST /api/runs/:id/steer                SteerRequest -> { delivered } (words into the turn now running; 409 if none)
 *   GET  /api/models                        ModelsResponse (models the engine can run)
 *   POST /api/ops/:op                       OpRequest -> OpResponse
 *   POST /api/notices/:id/(claim|present|acknowledge)   NoticeRequest -> Notice
 *     (the home node hands each notice to one outlet, named in `claimedBy`; that outlet shows it and says `present`.
 *      `claim` is how a device took one for itself before that; it is kept for those devices)
 *   POST /api/proposals/:id/(accept|decline)  ProposalRequest -> ProposalResponse (the user's decision; replays by request id)
 *   POST /api/proposals/:id/revise          ReviseRequest -> ProposalResponse (supersedes it; a new run in its conversation revises it)
 *   POST /api/settings                      SettingsRequest -> UserSettings (preferences that are not secrets; replays by request id)
 *   POST /api/presence                      PresenceRequest -> PresenceResponse
 *   POST /api/outlets                       OutletReport -> {} (a window or the Mac's figure says what it sees; not recorded)
 *   GET  /api/outlets                       OutletsResponse (which outlets have reported lately, and from which device)
 *   POST /api/projects                      AddProjectRequest -> Project (only on the home node's machine)
 *   POST /api/projects/:id/(trust|remove)   -> Project / {} (only on the home node's machine)
 *   (devices and pairing: see RemoteResponse below)
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
  /** `permission`: may it do this one action (answer `allow` or `deny`, or `always` when offered). `input`: a choice or a short answer. */
  kind: "input" | "permission";
  question: string;
  options: string[];
  /** For `permission`: exactly what would happen, such as a file's diff. */
  detail?: string;
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
  /** The page the user asked from. */
  context: ViewContext | null;
  /** The automation that started it on its schedule; null when the user asked. */
  automationId: string | null;
}
/** The page a request came from: its view, title, one line of what it shows, and what was selected on it. */
export interface ViewContext { view: string; title?: string; summary?: string; selection?: { id: string; title?: string } }

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** `provider/model` chosen for this conversation; null for the engine's default. */
  model: string | null;
  thinking: ThinkingLevel | null;
  /** Runs queued or in progress. */
  busy: number;
  /** Runs that need the user: a question waiting, or interrupted. */
  attention: number;
  lastGoal: string | null;
  /** The project it works in (a development session); null for an everyday conversation. Fixed at creation. */
  projectId: string | null;
  /** A development session's permission mode; null for an everyday conversation. */
  mode: SessionMode | null;
  /** The snapshot (a git commit) a development session's changes are measured against; null outside git. */
  base: string | null;
}

/** What a development session may do in its folder without asking: `plan` reads only; `ask` changes files, asking
 * each time with the diff; `edits` changes files inside the project without asking. Outside it, always asks. */
export type SessionMode = "plan" | "ask" | "edits";
/** What a development session has changed since its snapshot (GET /api/conversations/:id/changes). */
export interface SessionChanges {
  branch: string | null;
  base: string | null;
  files: Array<{ path: string; added: number; removed: number; created: boolean }>;
}

/** A folder on the home node Alfred may work in. Sessions start only once the user trusts it. */
export interface Project {
  id: string;
  name: string;
  /** Absolute, on the home node. */
  path: string;
  createdAt: string;
  trustedAt: string | null;
}
export interface AddProjectRequest { requestId?: string; path: string; name?: string }
export interface StartSessionRequest { requestId?: string; projectId: string; title: string; mode?: SessionMode }

export interface ConversationDetail {
  conversation: Conversation;
  /** Oldest first. */
  runs: Run[];
  /** Per run: its receipts (the events it wrote). */
  receipts: Record<string, CoreEvent[]>;
  /** Per run: how it went (`run.step`, `run.view`, `run.waiting`, `run.answered`, `run.steered`, `run.usage`), oldest first. */
  activity: Record<string, CoreEvent[]>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface UpdateConversationRequest { requestId?: string; title?: string; archived?: boolean; model?: string | null; thinking?: ThinkingLevel | null; mode?: SessionMode }

export interface SteerRequest { text: string }

export interface EngineModel { id: string; provider: string; name: string; reasoning: boolean; contextWindow?: number }
export interface ModelsResponse { models: EngineModel[] }

/** A run's reply as it is being written. Not recorded; the run's outcome is the record. */
export interface LiveUpdate { runId: string; conversationId: string; text: string }

export interface RespondRequest { requestId: string; answer: string }

export type NoticeState = "pending" | "claimed" | "presented" | "acknowledged" | "expired";

/** What a notice is to the user: it waits on them; it is news; or it is the welcome when they come back. */
export type NoticeClass = "needs_you" | "tells_you" | "greeting";

export interface Notice {
  id: string;
  eventSeq: number;
  kind: string;
  /** Which of the three it is, as the home node sees it. Absent from a home node older than this field. */
  class?: NoticeClass;
  state: NoticeState;
  createdAt: string;
  updatedAt: string;
  /** The outlet it was handed to (docs/design/attention.md): the one that is to show it, or that did. A device
   * shows only the notices handed to its own outlets. Two names are no device's: `push` (a phone's notification
   * told it) and `welcome` (it waited until the user came back, and the welcome told it). */
  claimedBy: string | null;
  /** Until when that outlet has to show it; after that the home node hands it on. */
  claimUntil: string | null;
  expiresAt: string | null;
  payload: Record<string, unknown>;
}

/** What a place that can tell the user something says about itself (docs/design/attention.md): a window of the
 * app, or the Mac's always-there figure. Sent when it changes and every half minute while someone is looking;
 * the home node keeps the latest in memory and forgets an outlet that stops reporting. */
export interface OutletReport {
  /** The name this outlet is handed notices under (a notice's `claimedBy`, and the `client` it says `present` with). */
  client: string;
  kind: "window" | "figure";
  /** A window: on screen and focused. The figure: its machine is awake and unlocked. */
  attending: boolean;
  /** How long since the user last did something there (in the window; on the machine), in milliseconds. Whether
   * that still counts as being there is the home node's to say (core attention.ts). */
  idleMs?: number;
}
export interface OutletInfo {
  client: string;
  kind: "window" | "figure";
  /** The paired device it reported from; `home` for the home node's own machine. */
  device: string;
  attending: boolean;
  /** Seconds since the user last did something there, when the outlet could tell. */
  idleSeconds: number | null;
  /** Seconds since it last reported. */
  reportedSecondsAgo: number;
}
export interface OutletsResponse { outlets: OutletInfo[] }

/** The languages Alfred speaks. */
export type Locale = "zh" | "en";
/** The user's preferences that are not secrets, shared by every device. */
export interface UserSettings {
  /** Null until a device sets it from its system language. */
  locale: Locale | null;
  /** The model a conversation uses unless it chose its own (`provider/model`); null: the engine's default. */
  model: string | null;
  /** The thinking level a conversation uses unless it chose its own; null: the model's default. */
  thinking: ThinkingLevel | null;
}
export interface SettingsRequest { requestId: string; patch: Partial<UserSettings> }

export type ProposalState = "open" | "executed" | "declined" | "stale" | "failed" | "superseded" | "expired";
/** One device operation a proposal will run, pinned to the exact records it names. */
export interface ProposalStep {
  op: string;
  input: unknown;
  preview: string;
  /** The whole of it, when there is more than a line to read (an email's text). */
  detail?: string;
}
/** Changes Alfred prepared that wait for the user's yes. Accepting runs exactly `steps`, once. */
export interface Proposal {
  id: string;
  state: ProposalState;
  title: string;
  summary: string;
  steps: ProposalStep[];
  subjects: string[];
  openedSeq: number;
  runId: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  outcome: { error?: string; receipts?: string[] } | null;
  /** Open ones: something it touches changed since; accepting would run nothing. */
  stale?: boolean;
}
export interface ProposalRequest { requestId: string }
export interface ReviseRequest { requestId: string; text: string }
export interface ProposalResponse { proposal: Proposal; replayed: boolean; run?: Run }

/** A part of life things belong to (work, health…), shared by the modules that sort by it; `k` is its colour slot. */
export interface Area { id: string; name: Record<Locale, string>; k: string }
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
  /** The areas things can belong to, in their fixed order. */
  areas: Area[];
  /** Proposals waiting for the user's decision, oldest first. */
  proposals: Proposal[];
  settings: UserSettings;
  /** The user's automations (the morning brief among them), with when each fires next. */
  automations: Automation[];
  /** Folders Alfred may work in, most recently added first. */
  projects: Project[];
}

export interface SubmitRunRequest { requestId: string; goal: string; conversationId?: string; context?: ViewContext }
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
  /** How many things wait on the user right now (questions, proposals, interrupted runs, changes outside that
   * failed or may not have happened). What only waited to be told is told by this welcome and not said again. */
  waiting: number;
}

export interface ErrorResponse { error: string; code?: string }

/** Connected accounts (docs/design/settings-and-connections.md). No secret ever appears here.
 *
 *   GET  /api/connections                             ConnectionsResponse
 *   POST /api/connections/google/connect              GoogleConnectRequest -> { flow: ConnectStart } (open flow.url in the system browser)
 *   GET  /api/connections/flows/:id                   ConnectFlow (poll until it is not `waiting`)
 *   POST /api/connections/flows/:id/cancel            -> ConnectFlow
 *   POST /api/connections/google/:email/disable       { capability } -> GoogleAccount (turning one on is `connect` with `account`)
 *   POST /api/connections/google/:email/disconnect    -> { revoked } (revoked at Google, then forgotten here)
 *   GET  /api/connections/google/:email/check         -> GoogleCheck (one small read-only count per capability that is on)
 */
export type GoogleCapability = "calRead" | "calWrite" | "mailRead" | "mailSend";
export interface GoogleAccount {
  email: string;
  /** Turned on by the user and granted by Google. */
  capabilities: GoogleCapability[];
  connectedAt: string;
  /** Google no longer honours the grant: connect again. */
  broken?: boolean;
}
export interface ConnectionsResponse {
  google: { client: { configured: boolean; source: string | null }; accounts: GoogleAccount[] };
}
/** A new account (no `account`), or more capabilities for one already connected. */
export interface GoogleConnectRequest { capabilities: GoogleCapability[]; account?: string }
export interface ConnectStart { id: string; url: string }
/** Events on the primary calendar in the next 7 days, and messages in the mailbox; a device words them. */
export interface GoogleCheck { calendar?: number; gmail?: number }
export type ConnectFlow =
  | { id: string; status: "waiting"; url: string }
  | { id: string; status: "done"; account: string; capabilities: GoogleCapability[]; missing: GoogleCapability[] }
  | { id: string; status: "failed"; error: string }
  | { id: string; status: "cancelled" };

/** Other devices (docs/research/remote-access.md). The home node's own machine is "local" and needs no pairing;
 * every other device reaches it through Tailscale Serve and carries a device token in an HttpOnly cookie.
 *
 *   GET  /api/remote                    RemoteResponse (local: the switch, the address, the devices; a device: itself)
 *   POST /api/remote                    { enabled } -> RemoteResponse            (local only)
 *   POST /api/remote/pairing            -> PairingCode (one code at a time)      (local only)
 *   POST /api/devices/:id/revoke        -> RemoteResponse                         (local only)
 *   POST /api/pair                      PairRequest -> { device } and the cookie (a device that is not paired yet)
 *   POST /api/device/forget             -> {} (a device revokes itself)
 *   GET  /api/push                      PushInfo                                   (a paired device)
 *   POST /api/push/subscribe            { subscription: PushSubscriptionJSON } -> PushInfo
 *   POST /api/push/unsubscribe          -> PushInfo
 *   POST /api/push/test                 -> PushResult (a test notification to this device)
 *
 * A device that is not paired gets 401 with code `unpaired` from every other /api/ route.
 */
export type DeviceKind = "desktop" | "phone" | "browser";
export interface DeviceInfo {
  id: string; name: string; kind: DeviceKind; via: string | null; pairedAt: string; lastSeenAt: string | null;
  /** It receives push notifications (a notice nobody took within seconds goes to it). */
  push?: boolean;
}
/** VAPID public key to subscribe with, and whether this device already is. */
export interface PushInfo { publicKey: string; subscribed: boolean }
/** Accepted by the push service, not proof it was seen. */
export interface PushResult { accepted: number; failed: number; expired: number }
/** What Tailscale on the home node's machine says. */
export interface TailscaleStatus {
  /** The `tailscale` command was found. */
  installed: boolean;
  /** Logged in and running. */
  running: boolean;
  /** This machine's name in the tailnet, e.g. mac-mini.tail1234.ts.net. */
  dnsName: string | null;
  /** The tailnet login that owns this machine; devices of other logins are refused. */
  owner: string | null;
  error?: string;
}
export type RemoteResponse =
  | {
    local: true;
    /** The user turned remote access on. */
    enabled: boolean;
    /** Serve is set up and points at Alfred: devices can connect. */
    serving: boolean;
    /** Where devices open Alfred, when serving. */
    url: string | null;
    port: number;
    tailscale: TailscaleStatus;
    devices: DeviceInfo[];
    error?: string;
  }
  | { local: false; device: DeviceInfo };
export interface PairingCode { code: string; url: string | null; expiresAt: string }
export interface PairRequest { code: string; name: string; kind: DeviceKind }

/** Automations: rules that start a run on a schedule (docs/design/workspace-architecture.md §5.2). Their runs are
 * unattended: reading and reversible changes only, everything else proposed. Every command replays by request id.
 *
 *   POST /api/automations                 NewAutomationRequest -> Automation
 *   POST /api/automations/:id             UpdateAutomationRequest -> Automation (rename, reword, reschedule, on/off)
 *   POST /api/automations/:id/run         { requestId } -> Run (now, outside the schedule)
 *   POST /api/automations/:id/delete      { requestId } -> {} (its runs and conversation stay)
 */
/** A time of day (HH:MM, the home node's local time) and weekdays, 1 (Monday) to 7 (Sunday). */
export interface Schedule { at: string; days: number[] }
export interface Automation {
  id: string;
  /** Null for a template (the morning brief), which is named in the user's language. */
  name: string | null;
  template: "brief" | null;
  /** What Alfred is told each time; null for a template. */
  goal: string | null;
  schedule: Schedule;
  enabled: boolean;
  conversationId: string | null;
  lastSlot: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
  /** When it fires next; null when it is off. */
  nextAt: string | null;
  lastRun: { id: string; state: RunState; at: string; reply: string | null } | null;
}
export interface NewAutomationRequest { requestId: string; name: string; goal: string; schedule: Schedule; enabled?: boolean }
export interface UpdateAutomationRequest { requestId: string; patch: { name?: string; goal?: string; schedule?: Schedule; enabled?: boolean } }

/** Models: who Alfred can think with, and signing in to them (docs/design/settings-and-connections.md §3.2).
 * Sign-in runs on the home node through Pi; a device shows each step and answers its questions.
 * No secret ever appears in a response.
 *
 *   GET  /api/connections/models                     ModelAccountsResponse
 *   POST /api/connections/models/:provider/login     { method: ModelAuthMethod } -> ModelSignIn
 *   GET  /api/connections/models/flows/:id           ModelSignIn (poll while `running`)
 *   POST /api/connections/models/flows/:id/answer    { promptId, value } -> ModelSignIn
 *   POST /api/connections/models/flows/:id/cancel    -> ModelSignIn
 *   POST /api/connections/models/:provider/logout    -> ModelAccountsResponse
 *   POST /api/connections/models/import              { providers } -> ModelAccountsResponse (API keys from the user's Pi setup)
 */
export type ModelAuthMethod = "oauth" | "api_key";
export interface ModelProvider {
  id: string;
  name: string;
  /** Signing in with an account; `subscription` when it uses the account's plan instead of pay-per-use credit. */
  oauth: { label: string; subscription: boolean } | null;
  /** It takes an API key. */
  apiKey: boolean;
  /** How Alfred can use it now: a credential Alfred keeps, or one from the environment. */
  status: { configured: boolean; method?: ModelAuthMethod; source?: "alfred" | "environment" };
  models: number;
}
export interface ModelAccountsResponse {
  providers: ModelProvider[];
  /** API keys in the user's Pi setup that Alfred does not have yet and can copy. */
  piKeys: Array<{ id: string; name: string }>;
  /** Subscriptions signed in to in Pi but not in Alfred: they are signed in again, not copied (one token cannot serve two programs). */
  piSubscriptions: Array<{ id: string; name: string }>;
}
export type ModelSignInStep =
  | { kind: "open_url"; url: string; instructions?: string }
  | { kind: "device_code"; code: string; url: string; expiresIn?: number }
  | { kind: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { kind: "progress"; message: string };
export interface ModelSignInPrompt {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}
export interface ModelSignIn {
  id: string;
  provider: string;
  method: ModelAuthMethod;
  status: "running" | "done" | "failed" | "cancelled";
  steps: ModelSignInStep[];
  /** A question waiting for the user. */
  prompt: ModelSignInPrompt | null;
  error?: string;
}
