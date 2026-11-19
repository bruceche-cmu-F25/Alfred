/** Alfred core: the world's event log, recoverable runs, notices and commands.
 * Moved out of Robin's extension/robin/alfred-core; it knows nothing about
 * HTTP, pages, engines or any particular module.
 */
export { openWorld, type Migration, type World } from "./world.ts";
export { CORE_MIGRATIONS, ACTORS, RUN_STATES, NOTICE_STATES, PROPOSAL_STATES } from "./schema.ts";
export { withCoreContext, withDefaultActor, coreContext, type Actor, type CoreContext } from "./context.ts";
export { newId } from "./ids.ts";
export { AREAS, AREA_IDS, isArea, areaName, type Area } from "./areas.ts";
export {
  recordDomainEvent, changedFields, listEvents, latestEventSeq, lastChanges, listRunReceipts, listRunActivity, RunLeaseLostError,
  type CoreEvent, type EventInput, type EventQuery,
} from "./events.ts";
export {
  submitRun, claimNextRun, heartbeatRun, finishRun, requestCancel, resumeRun, sweepRuns, interruptOrphanedRuns,
  getRun, listRuns, conversationBefore, RunError, RUN_LEASE_MS, openRequest, answerRequest, runAnswers, PERMISSION_ANSWERS,
  type Run, type RunOutcome, type RunRequest, type RunState, type SubmitRunInput, type ViewContext, viewContext,
} from "./runs.ts";
export {
  getConversation, listConversations, updateConversation, startSession, titleFrom, ConversationError, CONVERSATION_ID, THINKING_LEVELS,
  type Conversation, type ThinkingLevel,
} from "./conversations.ts";
export {
  listNotices, undeliveredNotices, isOpen, claimNotice, releaseNotice, presentNotice, acknowledgeNotice, createNotice, NoticeStateError,
  type Notice, type NoticeState,
} from "./notices.ts";
export { runCommand, commandReplay, CommandConflictError } from "./commands.ts";
export { attends, decide, noticeClass, ATTENTION, NOTICE_CLASSES, type AttentionPolicy, type Decision, type NoticeClass, type Outlet } from "./attention.ts";
export {
  reportPresence, isReturn, PRESENCE_KINDS, RETURN_AFTER_MS, AWAY_RETURN_MS,
  type AwayDigest, type PresenceKind, type PresenceOptions, type PresenceResult,
} from "./presence.ts";
export {
  executeNextRun, createRunDrain, localDate,
  type EngineModel, type EnginePort, type EngineRequest, type ExecuteOptions, type ExternalHooks, type RunDrain, type TurnUsage, type LiveUpdate, type RunProfile, type RunTool, type RunToolContext, type Workspace, type FileChange,
} from "./executor.ts";
export {
  openProposal, getProposal, listOpenProposals, acceptProposal, declineProposal, supersedeProposal, expireProposals, ProposalStateError, PROPOSAL_TTL_MS,
  type Proposal, type ProposalState, type ProposalStep,
} from "./proposals.ts";
export { getSettings, updateSettings, userLocale, localeOf, LOCALES, SettingsError, type Locale, type UserSettings } from "./settings.ts";
export {
  createAutomation, updateAutomation, deleteAutomation, getAutomation, listAutomations, fireDueAutomations, runAutomationNow, ensureTemplates,
  latestSlot, nextSlot, automationName, automationGoal, AutomationError, AUTOMATION_TEMPLATES, CATCH_UP_MS,
  type Automation, type AutomationView, type AutomationTemplate, type AutomationPatch, type NewAutomation, type Schedule,
} from "./automations.ts";
export { listProjects, getProject, addProject, trustProject, removeProject, ProjectError, PROJECT_ID, SESSION_MODES, type Project, type SessionMode } from "./projects.ts";
export { listDevices, pairDevice, deviceForToken, revokeDevice, hashToken, DeviceError, DEVICE_KINDS, type Device, type DeviceKind } from "./devices.ts";
export { defaultSecretStore, fileStore, keychainStore, type SecretStore } from "./secrets.ts";
export {
  enqueueOutbound, claimOutbound, finishOutbound, retryOutbound, interruptOutbound, getOutbound, listOutbound, OUTBOUND_STATES, OUTBOUND_MAX_ATTEMPTS,
  type Outbound, type OutboundState,
} from "./outbound.ts";
