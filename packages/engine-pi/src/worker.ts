/** An engine worker: a child process that runs Pi turns, one at a time.
 *
 * Each conversation has its own persistent Pi session (a JSONL file under
 * `<sessions>/<thread>/`), so the model keeps what it saw and did in earlier
 * turns, tool results included, and Pi compacts it when it grows. The session
 * sees only Alfred's instructions and tools: no built-in file or shell tools,
 * no extensions, skills or project context files. Credentials and the default
 * model come from the user's own Pi setup (~/.pi/agent).
 *
 *   worker.ts --cwd <dir> --sessions <dir> [--agent-dir <dir>]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createAgentSession, createExtensionRuntime, SessionManager, SettingsManager,
  type ResourceLoader, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RunJob, ToParent, ToWorker } from "./protocol.ts";

const { values } = parseArgs({ options: { cwd: { type: "string" }, sessions: { type: "string" }, "agent-dir": { type: "string" } } });
const cwd = values.cwd!;
const sessions = values.sessions!;
const agentDir = values["agent-dir"];
mkdirSync(cwd, { recursive: true });

const send = (message: ToParent) => process.send?.(message);
const THREAD = /^[A-Za-z0-9_-]{1,64}$/;

function resources(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** Tool calls wait here for the home node's answer. */
const pending = new Map<string, { resolve(text: string): void; reject(error: Error): void }>();
let current: { run: string; abort(): void } | null = null;
let calls = 0;

function tools(run: string, job: RunJob): ToolDefinition[] {
  return job.tools.map((spec): ToolDefinition => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters as unknown as ToolDefinition["parameters"],
    // One at a time: a tool may stop the run to ask the user.
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const call = String(++calls);
      const text = await new Promise<string>((resolve, reject) => {
        pending.set(call, { resolve, reject });
        send({ type: "tool", run, call, name: spec.name, params: params as Record<string, unknown> });
      });
      return { content: [{ type: "text", text }], details: undefined };
    },
  }));
}

async function runTurn(run: string, job: RunJob): Promise<string> {
  if (!THREAD.test(job.thread)) throw new Error("Invalid thread");
  const dir = join(sessions, job.thread);
  mkdirSync(dir, { recursive: true });
  const definitions = tools(run, job);
  const { session } = await createAgentSession({
    cwd,
    ...(agentDir ? { agentDir } : {}),
    resourceLoader: resources(job.instructions),
    // The conversation's own session: continued if it exists, created if not.
    sessionManager: SessionManager.continueRecent(cwd, dir),
    settingsManager: SettingsManager.create(cwd, agentDir),
    customTools: definitions,
    ...(definitions.length ? { tools: definitions.map((tool) => tool.name) } : { noTools: "all" as const }),
  });
  let aborted = false;
  current = { run, abort: () => { aborted = true; void session.abort(); } };
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
    await session.prompt(fresh && job.history ? `${job.history}\n\n---\n\n${job.prompt}` : job.prompt);
    if (aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return session.getLastAssistantText()?.trim() ?? "";
  } finally {
    unsubscribe();
    if (timer) clearTimeout(timer);
    current = null;
    session.dispose();
  }
}

process.on("message", (message: ToWorker) => {
  if (message.type === "run") {
    if (current) { send({ type: "error", run: message.run, message: "Worker is busy" }); return; }
    runTurn(message.run, message.job).then(
      (reply) => send({ type: "done", run: message.run, reply }),
      (error: unknown) => send({
        type: "error", run: message.run,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? { code: error.name } : {}),
      }),
    );
  } else if (message.type === "tool_result") {
    const waiting = pending.get(message.call);
    if (!waiting) return;
    pending.delete(message.call);
    if (message.ok) waiting.resolve(message.text);
    else waiting.reject(new Error(message.error));
  } else if (message.type === "abort") {
    if (current?.run === message.run) current.abort();
    for (const [call, waiting] of pending) { pending.delete(call); waiting.reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }
  }
});

// The home node went away: nothing to work for.
process.on("disconnect", () => process.exit(0));
