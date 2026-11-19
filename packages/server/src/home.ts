/** The home node: the one process that holds the world and executes runs.
 * A lock file keeps it single, which is what lets a fresh start treat every
 * run still marked running as orphaned.
 */
import { EventEmitter } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  CORE_MIGRATIONS, createRunDrain, interruptOutbound, listOutbound, ensureTemplates, fireDueAutomations, interruptOrphanedRuns, openWorld,
  type EngineModel, type EnginePort, type LiveUpdate, type PresenceOptions, type Run, type RunProfile, type World,
} from "@alfred/core";
import { assistantTools, moduleMigrations, runTools, type AlfredModule, type ModuleServices } from "@alfred/module-kit";

export const ASSISTANT_PROFILE = "assistant";
/** A development session's runs: the assistant's tools, plus reading its project's files (docs/design/dev-mode.md). */
export const DEVELOPER_PROFILE = "developer";
/** What an automation's runs get: nobody is there, so only reading and reversible changes; the rest is proposed. */
export const AUTOMATION_PROFILE = "automation";
/** Not for an automation's own runs: asking (nobody answers), and making or changing automations (only the user does). */
const UNATTENDED_EXCLUDED = new Set(["ask_user", "automation_add", "automation_update"]);
/** How often the home node's clock looks for automations that are due. */
const CLOCK_MS = 30_000;

const PERSONA = `You are Alfred, the user's personal assistant, carrying out one request in a conversation.
Use only the tools you have. Make exactly the changes the request asks for. If a wrong guess would matter,
ask with ask_user (offer short options); if the request needs something your tools cannot do, change
nothing and say briefly what is missing. Questions that need no change: just answer them. When the answer
is easier to see than to read (a list, a schedule), also open it with show_view.
Never claim a change you did not make with a tool. Some tools ask the user to allow each call; if they
decline, accept it and do not try another way.
Reply in one to three short sentences, in the language of the request.`;

const DEVELOPER = `You are Alfred, the user's personal assistant, working with them on code in a development session in
one of their projects (a folder on their computer; its name and path are below). You can read, search (grep, find)
and list its files freely; files outside it need the user's yes each time. You cannot change files or run commands in
this session yet: when a change is needed, say exactly what you would change and where. Answer from the code you
read, cite files as path:line, and say so when you have not checked something. If a wrong guess would matter, ask
with ask_user. Never claim a change you did not make with a tool. Reply in the language of the request, as long as
the answer needs and no longer.`;

const UNATTENDED = `This run was started by one of the user's automations, on its schedule: nobody is watching
and nobody can answer a question. Read, and make only changes that are easy to undo. For anything else (deleting,
anything you are unsure the user wants), use propose: it waits in the user's inbox for their yes.
Your reply is what the user reads when they come back, so make it complete on its own.`;

export interface HomeOptions {
  dataDir: string;
  engine: EnginePort;
  modules: readonly AlfredModule[];
  /** How long away counts as away (a user preference). */
  presence?: PresenceOptions;
  /** For the operator's log. */
  log?: (message: string) => void;
  /** The outside services the user has connected, for modules that mirror one (read when each sync runs). */
  services?: () => ModuleServices;
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
  /** Delivers the user's words into a running run; false if it is not running or cannot take them. */
  steer(runId: string, text: string): Promise<boolean>;
  /** The models the engine can run, for choosing one per conversation. */
  models(): Promise<EngineModel[]>;
  /** Refreshes a module's mirror of an outside service now (a device asked); resolves when done. */
  syncModule(id: string): Promise<void>;
  /** Delivers accepted outside changes now (after a proposal is accepted, an op clicked), not at the next sync. */
  deliver(): void;
  /** Starts the runs of automations that are due now (the clock calls it; tests call it with a time). */
  tickAutomations(now?: number): Run[];
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
      tools: [...runTools(world, modules), ...assistantTools(world, modules)],
    },
    [DEVELOPER_PROFILE]: {
      instructions: [DEVELOPER, guidance].filter(Boolean).join("\n\n"),
      // No page to open from a session: it is its own page.
      tools: [...runTools(world, modules), ...assistantTools(world, modules).filter((tool) => tool.name !== "show_view")],
      workspace: "read",
    },
    [AUTOMATION_PROFILE]: {
      instructions: [PERSONA, UNATTENDED, guidance].filter(Boolean).join("\n\n"),
      // Nothing irreversible is offered at all (not even to ask about), and nothing that asks.
      tools: [...runTools(world, modules, { askFor: [] }), ...assistantTools(world, modules).filter((tool) => !UNATTENDED_EXCLUDED.has(tool.name))],
      unattended: true,
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
  // Changes outside (an event, an email) the last node was in the middle of delivering: retried if that is safe.
  const cutOff = interruptOutbound(world);
  if (cutOff) options.log?.(`${cutOff} outbound change(s) were being delivered when the last home node stopped`);
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
  ensureTemplates(world);
  const tickAutomations = (now?: number): Run[] => {
    const fired = fireDueAutomations(world, { profile: AUTOMATION_PROFILE, now });
    if (fired.length) {
      options.log?.(`automations: started ${fired.length} run(s)`);
      kick();
    }
    return fired;
  };
  const clock = setInterval(() => {
    try { tickAutomations(); } catch (error) { options.log?.(`automations: ${error instanceof Error ? error.message : String(error)}`); }
  }, CLOCK_MS);
  clock.unref();

  // Modules that mirror an outside service (calendar, mail) refresh on their own schedule, one pass at a time each.
  const stopping = new AbortController();
  const syncing = new Map<string, Promise<void>>();
  const syncModule = (id: string): Promise<void> => {
    const module = options.modules.find((candidate) => candidate.id === id);
    if (!module?.sync) return Promise.reject(new Error(`No module ${id} to sync`));
    const running = syncing.get(id);
    if (running) return running;
    const pass = module.sync.run(world, options.services?.() ?? {}, stopping.signal)
      .catch((error) => { if (!stopping.signal.aborted) options.log?.(`sync ${id}: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => syncing.delete(id));
    syncing.set(id, pass);
    return pass;
  };
  const syncTimers = options.modules.filter((module) => module.sync).flatMap((module) => {
    const first = setTimeout(() => void syncModule(module.id), 2_000);
    const every = setInterval(() => void syncModule(module.id), module.sync!.everyMs);
    first.unref();
    every.unref();
    return [first, every];
  });
  return {
    world,
    modules: options.modules,
    presence: options.presence ?? {},
    owner,
    live,
    kick,
    steer: (runId, text) => drain.steer(runId, text),
    models: () => options.engine.models?.() ?? Promise.resolve([]),
    tickAutomations,
    syncModule,
    deliver: () => {
      const waiting = new Set(listOutbound(world, { states: ["queued"] }).map((outbound) => outbound.module));
      for (const module of options.modules) if (module.sync && waiting.has(module.id)) void syncModule(module.id);
    },
    idle: () => current,
    close() {
      clearInterval(clock);
      for (const timer of syncTimers) clearTimeout(timer);
      stopping.abort();
      world.close();
      unlock();
    },
  };
}
