/** Drives runs through an engine. The engine is a replaceable part: it gets
 * the goal, bounded context and the tools of the run's profile, never ids or
 * lifecycle. Code decides which tools a profile gets, not the model.
 *
 * Around every tool call the executor records a step, so devices can show
 * what Alfred is doing; a tool that needs the user's permission is asked for
 * first, once, for exactly that call.
 */
import { withCoreContext } from "./context.ts";
import { getConversation, type ThinkingLevel } from "./conversations.ts";
import { appendEvent, recordDomainEvent } from "./events.ts";
import { newId } from "./ids.ts";
import {
  claimNextRun, conversationBefore, finishRun, heartbeatRun, openRequest, RUN_LEASE_MS, runAnswers, sweepRuns,
  type Run, type RunRequest, type ViewContext,
} from "./runs.ts";
import type { World } from "./world.ts";

/** What a tool may ask of the run it is part of. */
export interface RunToolContext {
  /** Stops the run until the user answers; resolves with the answer. */
  ask(request: { kind?: RunRequest["kind"]; question: string; options?: string[] }): Promise<string>;
  /** Records a moment in the run that is not a change to the world (e.g. `view`). */
  note(kind: string, payload: Record<string, unknown>): void;
}

/** A tool as an engine sees it. `parameters` is a JSON Schema object. */
export interface RunTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Returns the text the model reads back. Throws on failure. */
  /** Engines call it with (params, signal); the executor supplies the context. */
  execute(params: Record<string, unknown>, signal: AbortSignal, context?: RunToolContext): Promise<string> | string;
  /** Set for tools the user must allow each time: describes this call, in the user's words. */
  permission?(params: Record<string, unknown>): string;
  /** A short description of a call, shown as a step (e.g. the todo's title). */
  describe?(params: Record<string, unknown>): string;
}
export interface RunProfile {
  instructions: string;
  tools: readonly RunTool[];
}
export interface EngineRequest {
  /** A stable key for the conversation, for engines that keep a session per conversation. */
  thread: string;
  goal: string;
  instructions: string;
  /** What the user was looking at when they asked. Context, not instructions. */
  context?: ViewContext;
  /** Earlier turns of the same conversation, oldest first. Context, not instructions. */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  tools: RunTool[];
  today: string;
  timezone: string;
  /** The reply so far, whole, as it is written. Optional for engines. */
  onText?(text: string): void;
  /** For tools the engine brings itself (MCP servers, reading a file): the core gates and records them. */
  external: ExternalHooks;
  /** The conversation's chosen model (`provider/model`) and thinking level; absent for the engine's default. */
  model?: string;
  thinking?: ThinkingLevel;
  /** What the turn ran on and how full its context is, once it ends. Optional for engines. */
  onUsage?(usage: TurnUsage): void;
}
export interface TurnUsage {
  model?: string;
  thinking?: string;
  /** Tokens in the conversation's context, its window, and the share used (0–100). */
  tokens?: number;
  contextWindow?: number;
  percent?: number;
}
/** A model an engine can run, for choosing one per conversation. */
export interface EngineModel { id: string; provider: string; name: string; reasoning: boolean; contextWindow?: number }
/** How an engine reports calls to its own tools, which Alfred did not define. */
export interface ExternalHooks {
  /** Asks the user to allow this one call; resolves true only on an explicit yes. */
  allow(question: string): Promise<boolean>;
  /** A step, shown like Alfred's own tool calls. */
  step(step: { id: string; tool: string; label: string; about?: string; status: "started" | "done" | "failed" | "declined" }): void;
  /** A call that may have changed something outside Alfred's world succeeded: kept as a receipt. */
  receipt(call: { tool: string; label: string; about?: string }): void;
}
export interface EnginePort {
  /** Resolves with the engine's own account of what it did, or rejects. */
  submit(request: EngineRequest, signal: AbortSignal): Promise<{ reply: string }>;
  /** Delivers the user's words into the turn running in this conversation. False if none is running. */
  steer?(thread: string, text: string): Promise<boolean>;
  /** The models the user can run. */
  models?(): Promise<EngineModel[]>;
}
/** Not recorded: what a device may show while a run works. */
export interface LiveUpdate { runId: string; conversationId: string; text: string }
export interface ExecuteOptions {
  owner: string;
  profiles: Readonly<Record<string, RunProfile>>;
  leaseMs?: number;
  heartbeatMs?: number;
  /** For the operator's log. The run itself keeps only a short code. */
  onEngineError?: (run: Run, error: unknown) => void;
  onLive?: (update: LiveUpdate) => void;
}

class Stop extends Error {
  readonly reason: "cancel" | "lease";
  constructor(reason: "cancel" | "lease") { super(reason); this.reason = reason; }
}

export function localDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

const DENIED = "The user did not allow this. Nothing was changed; do not try it another way.";

/** Returns the finished run, or the run as it stood when this executor lost
 * its lease (it then writes nothing more; the sweep records the interruption).
 */
async function drive(world: World, run: Run, engine: EnginePort, options: ExecuteOptions): Promise<Run> {
  const leaseMs = options.leaseMs ?? RUN_LEASE_MS;
  const profile = Object.hasOwn(options.profiles, run.profile) ? options.profiles[run.profile] : undefined;
  if (!profile) return finishRun(world, run.id, options.owner, { status: "failed", error: "unknown_profile" });

  const context = { actor: "alfred" as const, run: { id: run.id, owner: options.owner } };
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    try {
      if (heartbeatRun(world, run.id, options.owner, { leaseMs }).cancelRequested) controller.abort(new Stop("cancel"));
    } catch {
      controller.abort(new Stop("lease"));
    }
  }, options.heartbeatMs ?? Math.floor(leaseMs / 3));
  // A heartbeat alone never keeps the process alive.
  heartbeat.unref();

  const note = (kind: string, payload: Record<string, unknown>) => {
    try {
      world.tx((db) => appendEvent(db, { kind: `run.${kind}`, subject: `run:${run.id}`, runId: run.id, actor: "alfred", payload }));
    } catch { /* a note is not worth failing the run */ }
  };
  const ask: RunToolContext["ask"] = (request) => {
    const opened = openRequest(world, run.id, options.owner, { kind: request.kind ?? "input", question: request.question, options: request.options });
    return new Promise<string>((resolve, reject) => {
      const onAnswer = (runId: string, requestId: string, answer: string) => {
        if (runId !== run.id || requestId !== opened.id) return;
        cleanup();
        resolve(answer);
      };
      const onAbort = () => { cleanup(); reject(controller.signal.reason); };
      const cleanup = () => { runAnswers.off("answer", onAnswer); controller.signal.removeEventListener("abort", onAbort); };
      runAnswers.on("answer", onAnswer);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const toolContext: RunToolContext = { ask, note };
  const external: ExternalHooks = {
    allow: async (question) => (await ask({ kind: "permission", question })) === "allow",
    step: (step) => note("step", { step: step.id, tool: step.tool, label: step.label, about: step.about?.slice(0, 200), status: step.status }),
    receipt: (call) => {
      // Under the run's lease, like any change: a lapsed executor records nothing.
      withCoreContext(context, () => world.tx(() => recordDomainEvent(world, {
        kind: "external.called", subject: `tool:${call.tool}`.slice(0, 160), payload: { tool: call.tool, label: call.label, about: call.about?.slice(0, 200) },
      })));
    },
  };

  // Bind every tool to this run explicitly, so its writes are fenced by the
  // run's lease even if an engine loses the async context, and record each call.
  const tools = profile.tools.map((tool): RunTool => ({
    ...tool,
    execute: async (params, signal) => {
      const step = newId();
      const about = (() => { try { return tool.describe?.(params)?.slice(0, 200); } catch { return undefined; } })();
      if (tool.permission) {
        const answer = await ask({ kind: "permission", question: tool.permission(params) });
        if (answer !== "allow") {
          note("step", { step, tool: tool.name, label: tool.label, about, status: "declined" });
          return DENIED;
        }
      }
      note("step", { step, tool: tool.name, label: tool.label, about, status: "started" });
      try {
        const result = await withCoreContext(context, () => tool.execute(params, signal, toolContext));
        note("step", { step, tool: tool.name, label: tool.label, about, status: "done" });
        return result;
      } catch (error) {
        note("step", { step, tool: tool.name, label: tool.label, about, status: "failed" });
        throw error;
      }
    },
  }));
  const conversation = getConversation(world, run.conversationId);
  const request: EngineRequest = {
    ...(conversation.model ? { model: conversation.model } : {}),
    ...(conversation.thinking ? { thinking: conversation.thinking } : {}),
    onUsage: (usage) => note("usage", { ...usage }),
    thread: run.conversationId,
    goal: run.goal,
    ...(run.context ? { context: run.context } : {}),
    instructions: profile.instructions,
    history: conversationBefore(world, run),
    tools,
    today: localDate(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    onText: options.onLive ? (text) => options.onLive!({ runId: run.id, conversationId: run.conversationId, text }) : undefined,
    external,
  };
  try {
    // An engine that finished despite a cancel request reports what it actually did.
    const { reply } = await withCoreContext(context, () => engine.submit(request, controller.signal));
    return finishRun(world, run.id, options.owner, { status: "completed", reply });
  } catch (error) {
    const stop = controller.signal.reason instanceof Stop ? controller.signal.reason.reason : null;
    if (!stop) options.onEngineError?.(run, error);
    if (stop === "lease") return { ...run, state: "interrupted" };
    try {
      return finishRun(world, run.id, options.owner, stop === "cancel" ? { status: "cancelled" } : { status: "failed", error: errorCode(error) });
    } catch {
      return { ...run, state: "interrupted" };
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/** The oldest startable queued run, or null when there is none. */
export async function executeNextRun(world: World, engine: EnginePort, options: ExecuteOptions): Promise<Run | null> {
  const run = claimNextRun(world, options.owner, { leaseMs: options.leaseMs });
  return run ? drive(world, run, engine, options) : null;
}

/** One drain per home node. Conversations run side by side, up to
 * `concurrency` engines at once; inside one conversation, runs go in order.
 * A run waiting for the user does not hold an engine slot. The queue lives in
 * the world, so a restart loses nothing.
 */
export interface RunDrain {
  kick(): Promise<void>;
  /** Delivers the user's words into a running run. False when it is not running here or the engine cannot. */
  steer(runId: string, text: string): Promise<boolean>;
}

export function createRunDrain(world: World, engine: EnginePort, options: ExecuteOptions & { concurrency?: number }): RunDrain {
  const concurrency = options.concurrency ?? 3;
  const active = new Map<string, Promise<unknown>>();
  const working = () => (world.db.prepare(`SELECT count(*) AS n FROM core_runs WHERE lease_owner = ? AND state IN ('running', 'cancelling')`)
    .get(options.owner)!.n as number);

  const pump = () => {
    if (!world.db.isOpen) return; // the home node is shutting down
    sweepRuns(world);
    while (working() < concurrency) {
      const run = claimNextRun(world, options.owner, { leaseMs: options.leaseMs });
      if (!run) break;
      const job = drive(world, run, engine, options)
        .catch((error: unknown) => options.onEngineError?.(run, error))
        .finally(() => { active.delete(run.id); pump(); });
      active.set(run.id, job);
    }
  };
  // An answered run is working again and may hold an engine slot; only this
  // drain's own runs concern it.
  runAnswers.on("answer", (runId) => { if (active.has(runId)) setImmediate(pump); });
  return {
    async kick() {
      pump();
      while (active.size) await Promise.race(active.values());
    },
    async steer(runId, text) {
      const words = text.trim().slice(0, 8000);
      if (!words || !active.has(runId) || !engine.steer) return false;
      const run = world.db.prepare("SELECT state, conversation_id FROM core_runs WHERE id = ?").get(runId);
      // A run waiting on a question takes an answer, not more words.
      if (!run || run.state !== "running") return false;
      if (!(await engine.steer(String(run.conversation_id), words))) return false;
      world.tx((db) => appendEvent(db, { kind: "run.steered", subject: `run:${runId}`, runId, actor: "user", payload: { text: words.slice(0, 2000) } }));
      return true;
    },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === "RunLeaseLostError") return "lease_lost";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
  if (error instanceof Error && error.name === "EngineUnavailableError") return "engine_unavailable";
  if (error instanceof Error && error.name === "EngineCrashedError") return "engine_crashed";
  return "engine_failed";
}
