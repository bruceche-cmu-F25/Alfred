/** An engine worker: a child process that runs Pi turns, one at a time.
 *
 * Each conversation has its own persistent Pi session (a JSONL file under
 * `<sessions>/<thread>/`), so the model keeps what it saw and did in earlier
 * turns, tool results included, and Pi compacts it when it grows. The worker
 * keeps a conversation's session open between turns (warm, with its MCP
 * connections), like Pi Web, and closes it properly when it has been idle a
 * while, when another worker takes the conversation over, or on shutdown.
 *
 * What the model can use:
 * - Alfred's tools (todos and the rest), executed in the home node.
 * - MCP servers from Alfred's own `<config>/mcp.json` (same format as Pi's and
 *   Claude Desktop's), reached directly, through `tool_search` or `codemode`.
 * - Skills from `<config>/skills/`, and the `read` tool to load them.
 * - In a development session (a job with a workspace): the session works in the
 *   project's folder, with `read`, `grep`, `find` and `ls`, `edit` and `write`
 *   unless the session is in `plan` mode, and the project's AGENTS.md /
 *   CLAUDE.md as context. Its `.pi/` settings, extensions and MCP servers are
 *   not loaded.
 * Nothing else: no shell, no writing or editing files outside a session, none
 * of the user's own Pi extensions or packages.
 *
 * A gate checks every call to a tool Alfred did not define. MCP tools their
 * server marks read-only, reading Alfred's skills, and reading, searching or
 * listing inside a session's project folder run freely, and so do changes
 * inside it in `edits` mode; anything else asks the user first, through the
 * home node, once per call (a change shows its diff). A permitted call that may
 * have changed something outside Alfred is kept as a receipt.
 * Credentials and the default model come from the user's Pi setup.
 *
 *   worker.ts --cwd <dir> --sessions <dir> --config <dir> [--agent-dir <dir>]
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension, DefaultResourceLoader,
  loadProjectContextFiles, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { change, CHANGERS, countPatch, type Change } from "./changing.ts";
import { LOOKERS, look, real } from "./looking.ts";
import { loadAlfredMcpConfig } from "./mcp-config.ts";
import type { ExternalStep, ModelInfo, RunJob, ToParent, ToWorker } from "./protocol.ts";
import { defaultSecretStore } from "@alfred/core";
import { createCredentialStore } from "./credentials.ts";

const { values } = parseArgs({ options: { cwd: { type: "string" }, sessions: { type: "string" }, config: { type: "string" }, "agent-dir": { type: "string" } } });
const cwd = values.cwd!;
const sessions = values.sessions!;
const config = values.config ?? cwd;
const agentDir = values["agent-dir"];
// Model credentials are Alfred's own (credentials.ts, in the keychain), shared with the home node, where sign-in
// happens; a fresh runtime per session sees the latest. Custom models from Pi's models.json still apply.
const modelOptions = { credentials: createCredentialStore({ secrets: defaultSecretStore(config), lockDir: config }), ...(agentDir ? { modelsPath: join(agentDir, "models.json") } : {}) };
const skillsDir = join(config, "skills");
// Pi discovers extensions, skills and context files in an agent directory; Alfred's is empty on purpose.
const resourcesDir = join(cwd, "resources");
for (const dir of [cwd, resourcesDir, skillsDir]) mkdirSync(dir, { recursive: true });

const send = (message: ToParent) => process.send?.(message);
const THREAD = /^[A-Za-z0-9_-]{1,64}$/;
/** Tools that only reach other tools; the calls they make are gated one by one. */
const REACHERS = new Set(["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
const DENIED = "The user did not allow this call. Nothing was done; do not try it another way.";
/** A warm session idle this long is closed, as in Pi Web. */
const SESSION_IDLE_MS = 10 * 60_000;

let calls = 0;
const next = () => String(++calls);
/** Tool calls and permission questions wait here for the home node. */
const pending = new Map<string, { resolve(value: string | boolean): void; reject(error: Error): void }>();

/** A conversation's open session. `run` is the turn in progress, read by the gate and tools at call time. */
interface Warm {
  session: AgentSession;
  /** Instructions and tools it was opened with; a change reopens it. */
  shape: string;
  run: string | null;
  idle: NodeJS.Timeout | null;
  /** The session's mode for this turn; `always` once the user said "don't ask again" during it. */
  mode: string | null;
  always: boolean;
}
const warm = new Map<string, Warm>();
let busy = false;

function waitFor<T extends string | boolean>(call: string, message: ToParent): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.set(call, { resolve: resolve as (value: string | boolean) => void, reject });
    send(message);
  });
}

function about(input: unknown): string | undefined {
  const text = JSON.stringify(input ?? {});
  return text === "{}" ? undefined : text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** `mcp__<server>__<tool>` → server and tool, for the user to read. */
function describeTool(name: string): { label: string; server?: string; tool: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { label: `${match[1]} · ${match[2]}`, server: match[1], tool: match[2] } : { label: name, tool: name };
}

/** A diff is shown with the question up to this size; past it, its first part and a note. */
const MAX_DIFF = 11_000;

/** The gate: every call to a tool Alfred did not define passes here first. `root` is a development session's project folder. */
function gate(state: { run: string | null; mode: string | null; always: boolean }, ours: ReadonlySet<string>, root: string | null): ExtensionFactory {
  return (pi) => {
    const open = new Map<string, { step: ExternalStep; changes: boolean; run: string; file?: Change }>();
    pi.on("tool_call", async (event) => {
      const name = event.toolName;
      if (ours.has(name) || REACHERS.has(name)) return undefined;
      const run = state.run;
      if (!run) return { block: true, reason: "No turn is running." };
      const input = event.input as Record<string, unknown>;
      const step: ExternalStep = { id: next(), tool: name, label: describeTool(name).label, about: about(input), status: "started" };
      let question: string | null;
      let changes: boolean;
      let file: Change | undefined;
      let detail: string | undefined;
      let always = false;
      if (Object.hasOwn(CHANGERS, name)) {
        // Changing a file: inside the project, as the session's mode says (`edits`, or "don't ask again" this turn,
        // goes ahead); anything else asks, with the diff. Outside the project it always asks.
        file = change(name, input, { root, cwd });
        step.label = CHANGERS[name];
        step.about = file.shown;
        const free = file.inProject && (state.mode === "edits" || state.always);
        const verb = file.created ? "新建这个文件" : name === "write" ? "重写这个文件" : "改这个文件";
        question = free ? null : `允许 Alfred ${verb}吗？\n${file.path}`;
        detail = file.patch ? (file.patch.length > MAX_DIFF ? `${file.patch.slice(0, MAX_DIFF)}\n… (diff truncated)` : file.patch) : undefined;
        always = file.inProject;
        changes = false;
      } else if (Object.hasOwn(LOOKERS, name)) {
        // Alfred's own skills are instructions, and a session's project is the user's to read in it;
        // any other file is the user's and needs a yes.
        const seen = look(name, input, { root, cwd, skills: skillsDir });
        step.label = seen.label;
        step.about = seen.about;
        question = seen.free ? null : `允许 Alfred ${name === "read" ? "读取这个文件" : "查看这个位置"}吗？\n${seen.path}`;
        changes = false;
      } else {
        const hints = pi.getAllTools().find((tool) => tool.name === name)?.annotations;
        const readOnly = hints?.readOnlyHint === true && hints?.destructiveHint !== true;
        const { server, tool } = describeTool(name);
        question = readOnly ? null : `允许 Alfred 调用${server ? ` ${server} 的` : ""}「${tool}」吗？${step.about ? `\n${step.about}` : ""}`;
        changes = !readOnly;
      }
      if (question !== null) {
        const call = next();
        const answer = await waitFor<boolean | "always">(call, { type: "allow", run, call, question, ...(detail ? { detail } : {}), ...(always ? { always } : {}) });
        if (!answer) {
          send({ type: "step", run, step: { ...step, status: "declined" } });
          return { block: true, reason: DENIED };
        }
        // "Don't ask again": the rest of this turn's changes in the project go ahead (the session is now `edits`).
        if (answer === "always") state.always = true;
      }
      send({ type: "step", run, step });
      open.set(event.toolCallId, { step, changes, run, file });
      return undefined;
    });
    pi.on("tool_result", (event) => {
      const call = open.get(event.toolCallId);
      if (!call) return undefined;
      open.delete(event.toolCallId);
      send({ type: "step", run: call.run, step: { ...call.step, status: event.isError ? "failed" : "done" } });
      if (call.changes && !event.isError) send({ type: "receipt", run: call.run, tool: call.step.tool, label: call.step.label, about: call.step.about });
      if (call.file && !event.isError) {
        // The edit tool reports the patch it applied; count that rather than the preview when it is there.
        const applied = (event.details as { patch?: unknown } | undefined)?.patch;
        const counted = typeof applied === "string" ? countPatch(applied) : { added: call.file.added, removed: call.file.removed };
        send({ type: "changed", run: call.run, file: { path: call.file.shown, created: call.file.created, ...counted } });
      }
      return undefined;
    });
  };
}

function alfredTools(state: { run: string | null }, job: RunJob): ToolDefinition[] {
  return job.tools.map((spec): ToolDefinition => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters as unknown as ToolDefinition["parameters"],
    // One at a time: a tool may stop the run to ask the user.
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (!state.run) throw new Error("No turn is running");
      const call = next();
      const text = await waitFor<string>(call, { type: "tool", run: state.run, call, name: spec.name, params: params as Record<string, unknown> });
      return { content: [{ type: "text", text }], details: undefined };
    },
  }));
}

/** Closes a session the way Pi Web does: extensions (MCP) shut down, then dispose. */
async function close(thread: string): Promise<void> {
  const entry = warm.get(thread);
  if (!entry) return;
  warm.delete(thread);
  if (entry.idle) clearTimeout(entry.idle);
  const runner = entry.session.extensionRunner;
  if (runner.hasHandlers("session_shutdown")) {
    await Promise.race([
      runner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  entry.session.dispose();
}

async function open(job: RunJob): Promise<Warm> {
  const shape = createHash("sha256").update(JSON.stringify({ instructions: job.instructions, tools: job.tools, workspace: job.workspace ?? null })).digest("hex");
  const existing = warm.get(job.thread);
  if (existing && existing.shape === shape) return existing;
  if (existing) await close(job.thread);

  const dir = join(sessions, job.thread);
  mkdirSync(dir, { recursive: true });
  const state: Warm = { session: null as unknown as AgentSession, shape, run: null, idle: null, mode: job.workspace?.mode ?? null, always: false };
  const definitions = alfredTools(state, job);
  const root = job.workspace ? real(job.workspace.root) : null;
  const loader = new DefaultResourceLoader({
    // Resources are discovered in Alfred's own folder, never the project's: its .pi/ settings and extensions stay out.
    cwd,
    agentDir: resourcesDir,
    additionalSkillPaths: [skillsDir],
    noContextFiles: true,
    // A development session reads the project's AGENTS.md / CLAUDE.md (and its parents'), as Pi would there.
    ...(root ? { agentsFilesOverride: () => ({ agentsFiles: loadProjectContextFiles({ cwd: root, agentDir: resourcesDir }) }) } : {}),
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: job.workspace ? `${job.instructions}\n\nProject: ${job.workspace.name}\nFolder: ${root}` : job.instructions,
    extensionFactories: [
      { name: "alfred-gate", factory: gate(state, new Set(definitions.map((tool) => tool.name)), root), hidden: true },
      createCodemodeExtension(),
      createToolSearchExtension(),
      // Alfred's own servers, not the user's Pi configuration.
      createMcpExtension({
        loadConfig: () => loadAlfredMcpConfig(config) as never,
        logPath: join(cwd, "mcp.log"),
        startupWaitMs: 5000,
      }),
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    // Where the file tools work: the project in a development session.
    cwd: root ?? cwd,
    ...(agentDir ? { agentDir } : {}),
    resourceLoader: loader,
    // The conversation's own session: continued if it exists, created if not.
    sessionManager: SessionManager.continueRecent(root ?? cwd, dir),
    settingsManager: SettingsManager.create(cwd, agentDir),
    modelRuntime: await ModelRuntime.create(modelOptions),
    customTools: definitions,
    // Of Pi's built-in tools: `read` (skills; other files ask first), and in a development session also grep,
    // find and ls, and, unless it is in `plan` mode, edit and write (the gate asks as the mode says). No shell.
    ...(root ? { tools: ["+grep", "+find", "+ls"] } : {}),
    excludeTools: root && job.workspace?.mode !== "plan" ? ["bash", "powershell"] : ["bash", "edit", "write", "powershell"],
  });
  state.session = session;
  // Connects MCP servers in the background; they stay connected while the session is warm.
  await session.bindExtensions({});
  warm.set(job.thread, state);
  return state;
}

/** The conversation's chosen model and thinking level, when they differ from what the session uses. */
async function choose(session: AgentSession, job: RunJob): Promise<void> {
  if (job.model) {
    const slash = job.model.indexOf("/");
    const provider = job.model.slice(0, slash);
    const id = job.model.slice(slash + 1);
    const current = session.model;
    if (current?.provider !== provider || current.id !== id) {
      let model = session.modelRuntime.getModel(provider, id);
      if (!model) { await session.modelRuntime.refresh?.({ allowNetwork: false }); model = session.modelRuntime.getModel(provider, id); }
      if (!model) throw new Error(`Model not available: ${job.model}`);
      await session.setModel(model);
    }
  }
  if (job.thinking && session.thinkingLevel !== job.thinking) session.setThinkingLevel(job.thinking as never);
}

/** What this turn's model calls cost: tokens in and out, cache reads and writes, and dollars, summed over its replies. */
function spent(messages: readonly unknown[]): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of messages as Array<{ role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } }>) {
    if (message.role !== "assistant" || !message.usage) continue;
    const usage = message.usage;
    total.input += usage.input ?? 0;
    total.output += usage.output ?? 0;
    total.cacheRead += usage.cacheRead ?? 0;
    total.cacheWrite += usage.cacheWrite ?? 0;
    total.cost += usage.cost?.total ?? 0;
  }
  return total;
}

async function runTurn(run: string, job: RunJob): Promise<string> {
  if (!THREAD.test(job.thread)) throw new Error("Invalid thread");
  const entry = await open(job);
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = null;
  const { session } = entry;
  await choose(session, job);
  entry.run = run;
  entry.always = false;
  let aborted = false;
  currentAbort = () => { aborted = true; void session.abort(); };
  // The reply as it is written, whole each time, at most every 80 ms.
  let latest: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => { timer = null; if (latest !== null) { send({ type: "text", run, text: latest }); latest = null; } };
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_update" || event.message.role !== "assistant") return;
    const content = (event.message as { content?: unknown }).content;
    const text = Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("") : "";
    if (!text) return;
    latest = text;
    timer ??= setTimeout(flush, 80);
  });
  try {
    // A conversation that is older than its session gets its earlier turns once, as context.
    const fresh = session.messages.length === 0;
    const before = session.messages.length;
    const started = Date.now();
    await session.prompt(fresh && job.history ? `${job.history}\n\n---\n\n${job.prompt}` : job.prompt);
    if (aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const usage = session.getContextUsage();
    const model = session.model;
    send({
      type: "usage", run,
      usage: {
        ...(model ? { model: `${model.provider}/${model.id}` } : {}),
        thinking: session.thinkingLevel,
        ...spent(session.messages.slice(before)),
        durationMs: Date.now() - started,
        ...(usage ? { tokens: usage.tokens ?? undefined, contextWindow: usage.contextWindow, percent: usage.percent ?? undefined } : {}),
      },
    });
    return session.getLastAssistantText()?.trim() ?? "";
  } finally {
    unsubscribe();
    if (timer) clearTimeout(timer);
    entry.run = null;
    currentAbort = null;
    // Warm until idle, then closed properly.
    if (warm.get(job.thread) === entry) {
      entry.idle = setTimeout(() => void close(job.thread), SESSION_IDLE_MS);
      entry.idle.unref();
    }
  }
}

let currentAbort: (() => void) | null = null;

async function models(): Promise<ModelInfo[]> {
  const runtime = await ModelRuntime.create(modelOptions);
  return (await runtime.getAvailable()).map((model) => ({
    id: model.id, provider: model.provider, name: model.name ?? model.id, reasoning: Boolean(model.reasoning),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  }));
}

async function shutdown(): Promise<never> {
  currentAbort?.();
  await Promise.all([...warm.keys()].map(close));
  process.exit(0);
}

process.on("message", (message: ToWorker) => {
  if (message.type === "run") {
    if (busy) { send({ type: "error", run: message.run, message: "Worker is busy" }); return; }
    busy = true;
    runTurn(message.run, message.job).then(
      (reply) => send({ type: "done", run: message.run, reply }),
      (error: unknown) => send({
        type: "error", run: message.run,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? { code: error.name } : {}),
      }),
    ).finally(() => { busy = false; });
  } else if (message.type === "tool_result" || message.type === "allow_result") {
    const waiting = pending.get(message.call);
    if (!waiting) return;
    pending.delete(message.call);
    if (message.type === "allow_result") waiting.resolve(message.allowed && message.always ? "always" : message.allowed);
    else if (message.ok) waiting.resolve(message.text);
    else waiting.reject(new Error(message.error));
  } else if (message.type === "abort") {
    currentAbort?.();
    for (const [call, waiting] of pending) { pending.delete(call); waiting.reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }
  } else if (message.type === "steer") {
    const entry = [...warm.values()].find((candidate) => candidate.run === message.run);
    if (!entry) { send({ type: "steered", run: message.run, ok: false }); return; }
    entry.session.steer(message.text).then(
      () => send({ type: "steered", run: message.run, ok: true }),
      () => send({ type: "steered", run: message.run, ok: false }),
    );
  } else if (message.type === "release") {
    void close(message.thread);
  } else if (message.type === "models") {
    models().then(
      (list) => send({ type: "models_result", id: message.id, models: list }),
      (error: unknown) => send({ type: "models_result", id: message.id, models: [], error: error instanceof Error ? error.message : String(error) }),
    );
  } else if (message.type === "shutdown") {
    void shutdown();
  }
});

// The home node went away: close sessions (and their MCP servers), then exit.
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
