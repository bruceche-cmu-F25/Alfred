/** Runs an engine in worker processes, so a heavy or crashing model turn never
 * stalls or takes down the home node. Workers are started when needed, reused
 * while warm, and stopped after a while idle; a conversation's state lives in
 * its session file, so any worker can pick it up.
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { EnginePort, RunTool } from "@alfred/core";
import { composeHistory, composePrompt, type RunJob, type ToParent, type ToWorker } from "./protocol.ts";

export class EngineCrashedError extends Error {
  override name = "EngineCrashedError";
}

export interface WorkerEngineOptions {
  /** The worker module to run. */
  worker: string;
  /** Arguments for the worker (e.g. where sessions live). */
  args?: string[];
  /** A worker idle this long is stopped. */
  idleMs?: number;
  /** After asking a worker to stop a run, how long before it is killed. */
  abortGraceMs?: number;
  log?: (message: string) => void;
}

interface Worker {
  child: ChildProcess;
  busy: boolean;
  idle: NodeJS.Timeout | null;
  alive: boolean;
}

export interface WorkerEngine extends EnginePort {
  /** Stops every worker. */
  close(): void;
  /** Workers now running (tests, status). */
  size(): number;
}

export function createWorkerEngine(options: WorkerEngineOptions): WorkerEngine {
  const idleMs = options.idleMs ?? 5 * 60_000;
  const abortGraceMs = options.abortGraceMs ?? 5000;
  const workers = new Set<Worker>();

  const spawn = (): Worker => {
    // The same runtime as the home node (Node, or the Mac app's binary running as Node).
    const child = fork(options.worker, options.args ?? [], {
      execPath: process.execPath, execArgv: [], serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"], env: process.env,
    });
    const worker: Worker = { child, busy: false, idle: null, alive: true };
    child.on("exit", (code, signal) => {
      worker.alive = false;
      workers.delete(worker);
      if (worker.busy) options.log?.(`engine worker exited during a run (${signal ?? `code ${code}`})`);
    });
    workers.add(worker);
    return worker;
  };

  const acquire = (): Worker => {
    for (const worker of workers) {
      if (!worker.busy && worker.alive) {
        if (worker.idle) clearTimeout(worker.idle);
        worker.idle = null;
        worker.busy = true;
        return worker;
      }
    }
    const worker = spawn();
    worker.busy = true;
    return worker;
  };

  const release = (worker: Worker) => {
    worker.busy = false;
    if (!worker.alive) return;
    worker.idle = setTimeout(() => worker.child.kill(), idleMs);
    worker.idle.unref();
  };

  return {
    size: () => workers.size,
    close() {
      for (const worker of workers) worker.child.kill();
      workers.clear();
    },
    submit(request, signal) {
      signal.throwIfAborted();
      const run = randomBytes(6).toString("hex");
      const tools = new Map<string, RunTool>(request.tools.map((tool) => [tool.name, tool]));
      const job: RunJob = {
        thread: request.thread,
        instructions: request.instructions,
        prompt: composePrompt(request),
        history: composeHistory(request),
        tools: request.tools.map((tool) => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters })),
      };
      const worker = acquire();
      const send = (message: ToWorker) => { if (worker.alive && worker.child.connected) worker.child.send(message); };

      return new Promise<{ reply: string }>((resolve, reject) => {
        let settled = false;
        let killTimer: NodeJS.Timeout | null = null;
        const finish = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          worker.child.off("message", onMessage);
          worker.child.off("exit", onExit);
          signal.removeEventListener("abort", onAbort);
          if (killTimer) clearTimeout(killTimer);
          release(worker);
          outcome();
        };
        const onMessage = (message: ToParent) => {
          if (message.run !== run) return;
          if (message.type === "text") request.onText?.(message.text);
          else if (message.type === "done") finish(() => resolve({ reply: message.reply }));
          else if (message.type === "error") finish(() => reject(Object.assign(new Error(message.message), message.code ? { name: message.code } : {})));
          else if (message.type === "tool") {
            const tool = tools.get(message.name);
            if (!tool) { send({ type: "tool_result", run, call: message.call, ok: false, error: `Unknown tool ${message.name}` }); return; }
            // Runs here, in the home node: steps, permission and the run's lease apply.
            Promise.resolve()
              .then(() => tool.execute(message.params, signal))
              .then((text) => send({ type: "tool_result", run, call: message.call, ok: true, text: String(text) }))
              .catch((error: unknown) => send({ type: "tool_result", run, call: message.call, ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        };
        const onExit = () => finish(() => reject(signal.aborted ? signal.reason ?? new Error("aborted") : new EngineCrashedError("The engine process exited during the run")));
        const onAbort = () => {
          send({ type: "abort", run });
          // A worker that does not stop is killed; its run ends as aborted, not crashed.
          killTimer = setTimeout(() => worker.child.kill("SIGKILL"), abortGraceMs);
        };
        worker.child.on("message", onMessage);
        worker.child.on("exit", onExit);
        signal.addEventListener("abort", onAbort, { once: true });
        send({ type: "run", run, job });
      });
    },
  };
}
