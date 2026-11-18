/** The home node: the one process that holds the world and executes runs.
 * A lock file keeps it single, which is what lets a fresh start treat every
 * run still marked running as orphaned.
 */
import { EventEmitter } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  CORE_MIGRATIONS, createRunDrain, interruptOrphanedRuns, openWorld,
  type EnginePort, type LiveUpdate, type PresenceOptions, type Run, type RunProfile, type World,
} from "@alfred/core";
import { assistantTools, moduleMigrations, runTools, type AlfredModule } from "@alfred/module-kit";

export const ASSISTANT_PROFILE = "assistant";

const PERSONA = `You are Alfred, the user's personal assistant, carrying out one request in a conversation.
Use only the tools you have. Make exactly the changes the request asks for. If a wrong guess would matter,
ask with ask_user (offer short options); if the request needs something your tools cannot do, change
nothing and say briefly what is missing. Questions that need no change: just answer them. When the answer
is easier to see than to read (a list, a schedule), also open it with show_view.
Never claim a change you did not make with a tool. Some tools ask the user to allow each call; if they
decline, accept it and do not try another way.
Reply in one to three short sentences, in the language of the request.`;

export interface HomeOptions {
  dataDir: string;
  engine: EnginePort;
  modules: readonly AlfredModule[];
  /** How long away counts as away (a user preference). */
  presence?: PresenceOptions;
  /** For the operator's log. */
  log?: (message: string) => void;
}

export interface Home {
  world: World;
  modules: readonly AlfredModule[];
  presence: PresenceOptions;
  owner: string;
  /** What runs are writing right now (not recorded). Emits `update` with a LiveUpdate. */
  live: EventEmitter<{ update: [LiveUpdate] }>;
  /** Starts executing queued runs if it is not already. */
  kick(): void;
  /** Waits for the current drain (tests). */
  idle(): Promise<void>;
  close(): void;
}

class AlreadyRunningError extends Error {
  override name = "AlreadyRunningError";
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Lock files this process holds, so a second home in the same process is refused too. */
const held = new Set<string>();

function lock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      held.add(path);
      return () => {
        held.delete(path);
        try { if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8"));
      const ours = pid === process.pid && held.has(path);
      if (ours || (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid))) {
        throw new AlreadyRunningError(`Another Alfred home node is running (pid ${pid}) on this data directory`);
      }
      unlinkSync(path); // stale: its process is gone
    }
  }
  throw new AlreadyRunningError("Could not take the home node lock");
}

export function profiles(world: World, modules: readonly AlfredModule[]): Record<string, RunProfile> {
  const guidance = modules.map((module) => module.guidance).filter(Boolean).join("\n\n");
  return {
    [ASSISTANT_PROFILE]: {
      instructions: guidance ? `${PERSONA}\n\n${guidance}` : PERSONA,
      tools: [...runTools(world, modules), ...assistantTools(modules)],
    },
  };
}

export function openHome(options: HomeOptions): Home {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const unlock = lock(join(options.dataDir, "home-node.lock"));
  let world: World;
  try {
    world = openWorld(join(options.dataDir, "world.sqlite"), [...CORE_MIGRATIONS, ...moduleMigrations(options.modules)]);
  } catch (error) {
    unlock();
    throw error;
  }
  const owner = `home-${process.pid}-${Date.now().toString(36)}`;
  const orphaned = interruptOrphanedRuns(world, owner);
  if (orphaned) options.log?.(`${orphaned} run(s) were still running when the last home node stopped; marked interrupted, not re-run`);
  const live = new EventEmitter<{ update: [LiveUpdate] }>();
  live.setMaxListeners(0);
  const drain = createRunDrain(world, options.engine, {
    owner,
    profiles: profiles(world, options.modules),
    onLive: (update) => live.emit("update", update),
    onEngineError: (run: Run, error) => options.log?.(`run ${run.id} failed in the engine: ${error instanceof Error ? error.message : String(error)}`),
  });
  let current: Promise<void> = Promise.resolve();
  const kick = () => {
    current = drain.kick().catch((error) => options.log?.(`drain stopped: ${error instanceof Error ? error.message : String(error)}`));
  };
  return {
    world,
    modules: options.modules,
    presence: options.presence ?? {},
    owner,
    live,
    kick,
    idle: () => current,
    close() {
      world.close();
      unlock();
    },
  };
}
