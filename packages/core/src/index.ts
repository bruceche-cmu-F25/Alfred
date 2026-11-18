/** Alfred core: the world's event log, recoverable runs, notices and commands.
 * Moved out of Robin's extension/robin/alfred-core; it knows nothing about
 * HTTP, pages, engines or any particular module.
 */
export { openWorld, type Migration, type World } from "./world.ts";
export { CORE_MIGRATIONS, ACTORS, RUN_STATES, NOTICE_STATES } from "./schema.ts";
export { withCoreContext, withDefaultActor, coreContext, type Actor, type CoreContext } from "./context.ts";
export { newId } from "./ids.ts";
export {
  recordDomainEvent, changedFields, listEvents, latestEventSeq, listRunReceipts, listRunActivity, RunLeaseLostError,
  type CoreEvent, type EventInput, type EventQuery,
} from "./events.ts";
export {
  submitRun, claimNextRun, heartbeatRun, finishRun, requestCancel, resumeRun, sweepRuns, interruptOrphanedRuns,
  getRun, listRuns, conversationBefore, RunError, RUN_LEASE_MS, openRequest, answerRequest, runAnswers, PERMISSION_ANSWERS,
  type Run, type RunOutcome, type RunRequest, type RunState, type SubmitRunInput,
} from "./runs.ts";
export {
  getConversation, listConversations, updateConversation, titleFrom, ConversationError, CONVERSATION_ID,
  type Conversation,
} from "./conversations.ts";
export {
  listNotices, claimNotice, presentNotice, acknowledgeNotice, createNotice, NoticeStateError,
  type Notice, type NoticeState,
} from "./notices.ts";
export { runCommand, CommandConflictError } from "./commands.ts";
export {
  reportPresence, isReturn, PRESENCE_KINDS, RETURN_AFTER_MS, AWAY_RETURN_MS, HEARTBEAT_MS,
  type AwayDigest, type PresenceKind, type PresenceOptions, type PresenceResult,
} from "./presence.ts";
export {
  executeNextRun, createRunDrain, localDate,
  type EnginePort, type EngineRequest, type ExecuteOptions, type LiveUpdate, type RunProfile, type RunTool, type RunToolContext,
} from "./executor.ts";
