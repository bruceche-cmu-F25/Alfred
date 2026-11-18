/** The Pi engine adapter. Pi runs in worker processes (see pool.ts); each
 * conversation keeps a persistent Pi session (see worker.ts). Alfred's tools
 * still run in the home node, under the run's lease.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkerEngine, type WorkerEngine } from "./pool.ts";

export { createWorkerEngine, EngineCrashedError, type WorkerEngine, type WorkerEngineOptions } from "./pool.ts";
export { composeHistory, composePrompt, type RunJob, type ToolSpec, type ToParent, type ToWorker } from "./protocol.ts";

export interface PiEngineOptions {
  /** Working directory for sessions. Nothing is read from it. */
  cwd: string;
  /** Where conversations' sessions live; defaults to `<cwd>/sessions`. */
  sessions?: string;
  /** Pi's agent directory; defaults to Pi's own (~/.pi/agent). */
  agentDir?: string;
  idleMs?: number;
  log?: (message: string) => void;
}

export function createPiEngine(options: PiEngineOptions): WorkerEngine {
  const args = ["--cwd", options.cwd, "--sessions", options.sessions ?? join(options.cwd, "sessions")];
  if (options.agentDir) args.push("--agent-dir", options.agentDir);
  return createWorkerEngine({ worker: fileURLToPath(new URL("./worker.ts", import.meta.url)), args, idleMs: options.idleMs, log: options.log });
}
