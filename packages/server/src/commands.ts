/** The harness's own device commands: what a device asks of Alfred itself, outside any module. Its settings, the
 * user's automations, their decisions on proposals, conversations and sessions, projects, and what becomes of a run.
 *
 * Each is an operation in the module contract's sense (a name, an input that is checked, one change to the world),
 * and `command` runs it the way a module's operation is run (module-kit `runOp`): at most once per request id, and
 * recorded as the user's. So the rules of a device's command are in one place, whatever the command; http.ts only
 * says which address means which command.
 *
 * Three things a device sends are not here, because each already has rules of its own: a new run (replayed by its
 * request id in the runs themselves), an answer to a run's question (accepted once, for the question asked), and
 * words into a working run (they go to the engine, not the world).
 */
import { randomBytes } from "node:crypto";
import {
  acceptProposal, addProject, commandReplay, coreContext, createAutomation, declineProposal, deleteAutomation, getConversation, getProject,
  ProjectError, removeProject, requestCancel, resumeRun, revokeCommand, runAutomationNow, startSession, submitRun, supersedeProposal, trustProject,
  updateAutomation, updateConversation, updateSettings, userLocale, withCoreContext, type SessionMode, type ThinkingLevel, type World,
} from "@alfred/core";
import { applyStep, OpInputError, opInput, runOp, Type, UnknownOpError, type Static, type TSchema } from "@alfred/module-kit";
import type { Home } from "./home.ts";
import { ASSISTANT_PROFILE, AUTOMATION_PROFILE, DEVELOPER_PROFILE } from "./profiles.ts";
import { snapshot } from "./workspace.ts";

interface Extra<X> {
  /** The command's request id, for a command that starts a run of its own under it. */
  requestId: string;
  /** What `prepare` found. */
  prepared: X;
}

interface HarnessOp<P extends TSchema = TSchema, X = undefined> {
  /** `<what>.<verb>`, as the command is recorded. */
  name: string;
  input: P;
  /** May come without a request id: devices from before it took one send none. It is then done, but a retry of it
   * cannot be told from a second command. */
  unnumbered?: boolean;
  /** What must happen before the change and cannot happen inside a transaction (reading a repository). Not done
   * again when the command is a replay. */
  prepare?(home: Home, input: Static<P>): Promise<X>;
  /** The change. Synchronous; it runs inside the command's transaction. Returns JSON. */
  run(home: Home, input: Static<P>, extra: Extra<X>): unknown;
}
const define = <P extends TSchema, X = undefined>(op: HarnessOp<P, X>): HarnessOp => op as unknown as HarnessOp;

/** The profile a new run in this conversation gets: a development session's, or the assistant's. A session whose
 * project was removed or is no longer trusted takes no new requests. */
export function profileFor(world: World, conversationId: string | undefined | null): string {
  if (!conversationId) return ASSISTANT_PROFILE;
  const { projectId } = getConversation(world, conversationId);
  if (!projectId) return ASSISTANT_PROFILE;
  if (!getProject(world, projectId).trustedAt) throw new ProjectError("untrusted");
  return DEVELOPER_PROFILE;
}

const Id = Type.String({ minLength: 1, maxLength: 64 });
const Patch = Type.Record(Type.String(), Type.Unknown());
const Said = Type.String({ pattern: "\\S" });

const OPS: readonly HarnessOp[] = [
  // Preferences that are not secrets (the language, the default model). What a patch may hold is the core's to say.
  define({
    name: "settings.update", input: Type.Object({ patch: Patch }),
    run: (home, input) => updateSettings(home.world, input.patch),
  }),

  // Automations: the user's own rules. Their runs are unattended.
  define({
    name: "automation.create",
    input: Type.Object({ name: Type.Optional(Type.String()), goal: Type.Optional(Type.String()), schedule: Type.Unknown(), enabled: Type.Optional(Type.Boolean()) }),
    run: (home, input) => createAutomation(home.world, { name: input.name, goal: input.goal, schedule: input.schedule, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) }),
  }),
  define({
    name: "automation.update", input: Type.Object({ id: Id, patch: Patch }),
    run: (home, input) => updateAutomation(home.world, input.id, input.patch),
  }),
  define({
    name: "automation.delete", input: Type.Object({ id: Id }),
    run: (home, input) => { deleteAutomation(home.world, input.id); return {}; },
  }),
  define({
    name: "automation.run", input: Type.Object({ id: Id }),
    run: (home, input, { requestId }) => runAutomationNow(home.world, input.id, requestId, { profile: AUTOMATION_PROFILE }),
  }),

  // The user's decisions on proposals.
  define({
    name: "proposal.accept", input: Type.Object({ id: Id }),
    // The steps are Alfred's changes, made on the user's yes to this proposal (the context keeps which one).
    run: (home, input) => ({
      proposal: acceptProposal(home.world, input.id, (step) => withCoreContext({ ...coreContext(), actor: "alfred" }, () => applyStep(home.world, home.modules, step))),
    }),
  }),
  define({
    name: "proposal.decline", input: Type.Object({ id: Id }),
    run: (home, input) => ({ proposal: declineProposal(home.world, input.id) }),
  }),
  define({
    // `context`: the page it was changed from and what was picked there (a mail), so that page can show the new version
    // being written where the old one was.
    name: "proposal.revise", input: Type.Object({ id: Id, text: Said, context: Type.Optional(Type.Unknown()) }),
    // The proposal is superseded, and a run in its conversation is asked to propose again with the change.
    run(home, input, { requestId }) {
      const superseded = supersedeProposal(home.world, input.id, input.text);
      // The whole of each step (an email's text), so the new version starts from what the user saw.
      const steps = superseded.steps.map((step) => (step.detail ? `${step.preview}\n${step.detail}` : step.preview));
      const goal = userLocale(home.world) === "zh"
        ? `修改你之前的提议「${superseded.title}」：${input.text.trim()}\n原来的提议：${superseded.summary}\n步骤：${steps.join("；")}\n请按修改意见重新提议（用 propose），不要直接改。`
        : `Change your earlier proposal "${superseded.title}": ${input.text.trim()}\nThe proposal was: ${superseded.summary}\nSteps: ${steps.join("; ")}\nPropose again with the change (use propose); do not make the changes directly.`;
      const profile = profileFor(home.world, superseded.conversationId);
      const { run } = submitRun(home.world, {
        requestId: `${requestId}.revise`, goal, profile, conversationId: superseded.conversationId ?? undefined,
        ...(input.context !== undefined && profile === ASSISTANT_PROFILE ? { context: input.context } : {}),
      });
      return { proposal: superseded, run };
    },
  }),

  // Conversations. An everyday one starts with its first message (a run); a development session is started here.
  define({
    name: "conversation.start", unnumbered: true,
    input: Type.Object({ projectId: Id, title: Said, mode: Type.Optional(Type.Union([Type.Literal("plan"), Type.Literal("ask"), Type.Literal("edits")])) }),
    async prepare(home, input) {
      // Nothing runs in a folder, not even git, before the user has trusted it.
      const folder = getProject(home.world, input.projectId);
      if (!folder.trustedAt) throw new ProjectError("untrusted");
      // The snapshot the session's changes are measured against, taken before it can change anything.
      return snapshot(folder.path);
    },
    run: (home, input, { prepared: base }) => startSession(home.world, { projectId: input.projectId, title: input.title, mode: input.mode, base }),
  }),
  define({
    name: "conversation.update", unnumbered: true,
    input: Type.Object({
      id: Id, title: Type.Optional(Type.String()), archived: Type.Optional(Type.Boolean()),
      model: Type.Optional(Type.Union([Type.String(), Type.Null()])), thinking: Type.Optional(Type.Union([Type.String(), Type.Null()])), mode: Type.Optional(Type.String()),
      /** A command allowed for the rest of the session, taken back: it asks again. */
      forgetCommand: Type.Optional(Type.String({ maxLength: 300 })),
    }),
    // Which models, levels and modes there are is the core's to say.
    run: (home, input) => {
      if (input.forgetCommand !== undefined) revokeCommand(home.world, input.id, input.forgetCommand);
      return updateConversation(home.world, input.id, {
        title: input.title, archived: input.archived, model: input.model,
        thinking: input.thinking as ThinkingLevel | null | undefined, mode: input.mode as SessionMode | undefined,
      });
    },
  }),

  // Projects. http.ts lets only the home node's own machine send these: a folder path means something only there.
  define({
    name: "project.add", unnumbered: true, input: Type.Object({ path: Type.String(), name: Type.Optional(Type.String()) }),
    run: (home, input) => addProject(home.world, { path: input.path, name: input.name }),
  }),
  define({
    name: "project.trust", unnumbered: true, input: Type.Object({ id: Id }),
    run: (home, input) => trustProject(home.world, input.id),
  }),
  define({
    name: "project.remove", unnumbered: true, input: Type.Object({ id: Id }),
    run: (home, input) => { removeProject(home.world, input.id); return {}; },
  }),

  // What becomes of a run.
  define({
    name: "run.cancel", unnumbered: true, input: Type.Object({ id: Id }),
    run: (home, input) => requestCancel(home.world, input.id),
  }),
  define({
    name: "run.resume", unnumbered: true, input: Type.Object({ id: Id }),
    run: (home, input) => resumeRun(home.world, input.id),
  }),
];
const BY_NAME = new Map(OPS.map((op) => [op.name, op]));

/** The names of the harness's commands. */
export const HARNESS_COMMANDS: readonly string[] = OPS.map((op) => op.name);

/**
 * A device's command to the harness. `sent` is the request's body (its `requestId` and the command's own fields);
 * `where` is what the address said (which automation, which run), and wins over the body.
 * Resolves with the command's result and whether it was a replay; throws what the operation throws.
 */
export async function command(home: Home, name: string, sent: Record<string, unknown>, where: Record<string, unknown> = {}): Promise<{ result: unknown; replayed: boolean }> {
  const op = BY_NAME.get(name);
  if (!op) throw new UnknownOpError(name);
  const { requestId: given, ...fields } = sent;
  if (given !== undefined && typeof given !== "string") throw new OpInputError("requestId must be text");
  if (given === undefined && !op.unnumbered) throw new OpInputError("requestId is required");
  const requestId = typeof given === "string" ? given : `home.${randomBytes(12).toString("hex")}`;
  const input = opInput(op, { ...fields, ...where });
  const done = commandReplay(home.world, { requestId, command: op.name, input });
  if (done) return { result: done.result, replayed: true };
  const prepared = op.prepare ? await op.prepare(home, input) : undefined;
  const outcome = runOp(home.world, { name: op.name, input: op.input, run: () => op.run(home, input, { requestId, prepared }) }, { requestId, input });
  // Whatever it was, there may now be a run to start or an accepted change to send.
  home.kick();
  home.deliver();
  return outcome;
}
