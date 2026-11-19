/** Automations: rules that start a run on a schedule, like the morning brief (docs/design/workspace-architecture.md §5.2).
 *
 * An automation is not a run; each time it fires it starts one, in its own conversation, with the unattended profile
 * the home node gives it (read and reversible changes only; anything else becomes a proposal). Invariants:
 *  1. One run per firing: the run's request id is the automation and the slot, so a second tick, or a restart, replays.
 *  2. A slot missed while the home node was off fires late at most once: only the latest slot due is ever considered,
 *     and if it is more than CATCH_UP_MS late it is skipped (and recorded) instead.
 *  3. Turned off, it never fires; turned on or rescheduled, it starts from the next slot, never one already past.
 * Times are the home node's local time.
 */
import type { DatabaseSync } from "node:sqlite";
import { withDefaultActor } from "./context.ts";
import { createConversation } from "./conversations.ts";
import { recordDomainEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import { submitRun, type Run, type RunState } from "./runs.ts";
import { userLocale, type Locale } from "./settings.ts";
import { AUTOMATION_TEMPLATES, TEMPLATE_TEXT, type AutomationTemplate } from "./automation-templates.ts";
import type { World } from "./world.ts";

/** Every day is all seven; weekdays are 1 (Monday) to 7 (Sunday). */
export interface Schedule { at: string; days: number[] }
export { AUTOMATION_TEMPLATES, type AutomationTemplate };
/** A slot more than this late (the home node was off) is skipped, not run. */
export const CATCH_UP_MS = 12 * 60 * 60 * 1000;
/** Fired this much after its slot, a run says it is late. */
const LATE_MS = 5 * 60 * 1000;

export interface Automation {
  id: string;
  /** The user's name for it; null for a template that keeps its own name in the user's language. */
  name: string | null;
  template: AutomationTemplate | null;
  /** What Alfred is told each time; null for a template, whose words follow the user's language. */
  goal: string | null;
  schedule: Schedule;
  enabled: boolean;
  /** Where its runs go; made on the first firing. */
  conversationId: string | null;
  /** The last slot it fired for or skipped (ISO). */
  lastSlot: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An automation as a page shows it: when it next fires and how its last run went. */
export interface AutomationView extends Automation {
  nextAt: string | null;
  lastRun: { id: string; state: RunState; at: string; reply: string | null } | null;
}

export class AutomationError extends Error {
  override name = "AutomationError";
  readonly code: "missing" | "invalid";
  constructor(code: "missing" | "invalid", message?: string) {
    super(message ?? (code === "missing" ? "No such automation" : "Invalid automation"));
    this.code = code;
  }
}

export const automationName = (automation: Pick<Automation, "name" | "template">, locale: Locale): string =>
  automation.name ?? (automation.template ? TEMPLATE_TEXT[automation.template][locale].name : "");
export const automationGoal = (automation: Pick<Automation, "goal" | "template">, locale: Locale): string =>
  automation.goal ?? (automation.template ? TEMPLATE_TEXT[automation.template][locale].goal : "");

function schedule(value: unknown): Schedule {
  const input = value as { at?: unknown; days?: unknown } | null;
  if (!input || typeof input !== "object") throw new AutomationError("invalid", "schedule must be { at, days }");
  if (typeof input.at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.at)) throw new AutomationError("invalid", "schedule.at must be HH:MM");
  const days = Array.isArray(input.days) ? [...new Set(input.days)] : [];
  if (!days.length || days.some((day) => !Number.isInteger(day) || (day as number) < 1 || (day as number) > 7)) {
    throw new AutomationError("invalid", "schedule.days must be weekdays 1 (Monday) to 7 (Sunday)");
  }
  return { at: input.at, days: (days as number[]).sort((a, b) => a - b) };
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new AutomationError("invalid", `${field} must be 1–${max} characters`);
  return value.trim();
}

const weekday = (date: Date) => ((date.getDay() + 6) % 7) + 1;
function at(base: Date, dayOffset: number, schedule: Schedule): Date {
  const [hours, minutes] = schedule.at.split(":").map(Number);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hours, minutes);
}

/** The latest slot at or before `now`, in local time. */
export function latestSlot(schedule: Schedule, now: number): number | null {
  const today = new Date(now);
  for (let back = 0; back <= 7; back++) {
    const slot = at(today, -back, schedule);
    if (slot.getTime() <= now && schedule.days.includes(weekday(slot))) return slot.getTime();
  }
  return null;
}

/** The first slot after `now`. */
export function nextSlot(schedule: Schedule, now: number): number | null {
  const today = new Date(now);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const slot = at(today, ahead, schedule);
    if (slot.getTime() > now && schedule.days.includes(weekday(slot))) return slot.getTime();
  }
  return null;
}

function toAutomation(row: Record<string, unknown>): Automation {
  return {
    id: row.id as string, name: row.name as string | null, template: row.template as AutomationTemplate | null, goal: row.goal as string | null,
    schedule: JSON.parse(row.schedule as string) as Schedule, enabled: row.enabled === 1, conversationId: row.conversation_id as string | null,
    lastSlot: row.last_slot as string | null, lastRunId: row.last_run_id as string | null,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
  };
}

function load(db: DatabaseSync, id: string): Automation {
  const row = db.prepare("SELECT * FROM core_automations WHERE id = ?").get(id);
  if (!row) throw new AutomationError("missing");
  return toAutomation(row);
}

export function getAutomation(world: World, id: string): Automation {
  return load(world.db, id);
}

export function listAutomations(world: World, now: number = Date.now()): AutomationView[] {
  const rows = world.db.prepare("SELECT * FROM core_automations ORDER BY created_at, id").all().map(toAutomation);
  const lastRun = world.db.prepare("SELECT id, state, updated_at, outcome FROM core_runs WHERE id = ?");
  return rows.map((automation) => {
    const run = automation.lastRunId ? lastRun.get(automation.lastRunId) : undefined;
    const next = automation.enabled ? nextSlot(automation.schedule, now) : null;
    const outcome = run?.outcome ? JSON.parse(run.outcome as string) as { reply?: string } : null;
    return {
      ...automation,
      nextAt: next === null ? null : iso(next),
      lastRun: run ? { id: run.id as string, state: run.state as RunState, at: run.updated_at as string, reply: outcome?.reply?.slice(0, 280) ?? null } : null,
    };
  });
}

export interface NewAutomation { name?: string; goal?: string; template?: AutomationTemplate; schedule: unknown; enabled?: boolean }

export function createAutomation(world: World, input: NewAutomation, now: number = Date.now()): Automation {
  const template = input.template ?? null;
  if (template !== null && !AUTOMATION_TEMPLATES.includes(template)) throw new AutomationError("invalid", "Unknown template");
  const name = input.name === undefined && template ? null : text(input.name, "name", 60);
  const goal = input.goal === undefined && template ? null : text(input.goal, "goal", 2000);
  const when = schedule(input.schedule);
  const enabled = input.enabled ?? true;
  return world.tx((db) => {
    const id = newId();
    const last = latestSlot(when, now);
    db.prepare(`INSERT INTO core_automations (id, name, template, goal, schedule, enabled, last_slot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, template, goal, JSON.stringify(when), enabled ? 1 : 0, last === null ? null : iso(last), iso(now), iso(now));
    recordDomainEvent(world, { kind: "automation.created", subject: `automation:${id}`, payload: { name, template, schedule: when, enabled }, now });
    return load(db, id);
  });
}

export interface AutomationPatch { name?: unknown; goal?: unknown; schedule?: unknown; enabled?: unknown }

/** Rename, reword, reschedule, or turn on and off. Turning on or rescheduling starts from the next slot. */
export function updateAutomation(world: World, id: string, patch: AutomationPatch, now: number = Date.now()): Automation {
  const unknown = Object.keys(patch).filter((key) => !["name", "goal", "schedule", "enabled"].includes(key));
  if (unknown.length) throw new AutomationError("invalid", `Unknown field: ${unknown.join(", ")}`);
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new AutomationError("invalid", "enabled must be true or false");
  return world.tx((db) => {
    const before = load(db, id);
    const after: Automation = {
      ...before,
      ...(patch.name !== undefined ? { name: text(patch.name, "name", 60) } : {}),
      ...(patch.goal !== undefined ? { goal: text(patch.goal, "goal", 2000) } : {}),
      ...(patch.schedule !== undefined ? { schedule: schedule(patch.schedule) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled as boolean } : {}),
    };
    const rescheduled = JSON.stringify(after.schedule) !== JSON.stringify(before.schedule);
    const switchedOn = after.enabled && !before.enabled;
    const changes: Record<string, [unknown, unknown]> = {};
    for (const key of ["name", "goal", "schedule"] as const) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = [before[key], after[key]];
    }
    if (!Object.keys(changes).length && after.enabled === before.enabled) return before;
    const last = rescheduled || switchedOn ? latestSlot(after.schedule, now) : null;
    db.prepare(`UPDATE core_automations SET name = ?, goal = ?, schedule = ?, enabled = ?, updated_at = ?${rescheduled || switchedOn ? ", last_slot = ?" : ""} WHERE id = ?`)
      .run(after.name, after.goal, JSON.stringify(after.schedule), after.enabled ? 1 : 0, iso(now), ...(rescheduled || switchedOn ? [last === null ? null : iso(last)] : []), id);
    if (Object.keys(changes).length) recordDomainEvent(world, { kind: "automation.updated", subject: `automation:${id}`, payload: { changes }, now });
    if (after.enabled !== before.enabled) recordDomainEvent(world, { kind: "automation.toggled", subject: `automation:${id}`, payload: { enabled: after.enabled }, now });
    return load(db, id);
  });
}

/** Its runs and conversation stay; they no longer have an automation behind them. */
export function deleteAutomation(world: World, id: string, now: number = Date.now()): void {
  world.tx((db) => {
    const automation = load(db, id);
    db.prepare("DELETE FROM core_automations WHERE id = ?").run(id);
    recordDomainEvent(world, { kind: "automation.deleted", subject: `automation:${id}`, payload: { name: automation.name, template: automation.template }, now });
  });
}

export interface FireOptions {
  /** The run profile automations run under (the home node's unattended one). */
  profile: string;
  now?: number;
}

function fire(world: World, automation: Automation, input: { requestId: string; slot: number | null; profile: string; now: number }): Run {
  return world.tx((db) => {
    const locale = userLocale(world);
    const late = input.slot !== null && input.now - input.slot > LATE_MS;
    const slotTime = input.slot === null ? "" : new Date(input.slot).toTimeString().slice(0, 5);
    const goal = automationGoal(automation, locale) + (late ? `\n\n(Scheduled for ${slotTime}; running late because Alfred was not running then.)` : "");
    const conversationId = automation.conversationId && db.prepare("SELECT 1 FROM core_conversations WHERE id = ?").get(automation.conversationId)
      ? automation.conversationId
      : createConversation(db, { title: automationName(automation, locale), now: input.now });
    const { run, replayed } = submitRun(world, { requestId: input.requestId, goal, profile: input.profile, conversationId, automationId: automation.id, now: input.now });
    if (replayed) return run;
    db.prepare(`UPDATE core_automations SET conversation_id = ?, last_run_id = ?${input.slot === null ? "" : ", last_slot = ?"} WHERE id = ?`)
      .run(conversationId, run.id, ...(input.slot === null ? [] : [iso(input.slot)]), automation.id);
    recordDomainEvent(world, {
      kind: "automation.fired", subject: `automation:${automation.id}`, now: input.now,
      payload: { runId: run.id, slot: input.slot === null ? null : iso(input.slot), late, manual: input.slot === null },
    });
    return run;
  });
}

/** For the home node's clock: start a run for every automation whose slot has come, and skip slots too late to run.
 * Safe to call as often as you like. Returns the runs it started. */
export function fireDueAutomations(world: World, options: FireOptions): Run[] {
  return withDefaultActor("system", () => fireDue(world, options));
}

function fireDue(world: World, options: FireOptions): Run[] {
  const now = options.now ?? Date.now();
  const fired: Run[] = [];
  const rows = world.db.prepare("SELECT * FROM core_automations WHERE enabled = 1 ORDER BY created_at, id").all().map(toAutomation);
  for (const automation of rows) {
    const slot = latestSlot(automation.schedule, now);
    if (slot === null || (automation.lastSlot !== null && slot <= Date.parse(automation.lastSlot))) continue;
    if (now - slot > CATCH_UP_MS) {
      world.tx((db) => {
        db.prepare("UPDATE core_automations SET last_slot = ? WHERE id = ?").run(iso(slot), automation.id);
        recordDomainEvent(world, { kind: "automation.skipped", subject: `automation:${automation.id}`, payload: { slot: iso(slot), reason: "too_late" }, now });
      });
      continue;
    }
    fired.push(fire(world, automation, { requestId: `auto:${automation.id}:${slot}`, slot, profile: options.profile, now }));
  }
  return fired;
}

/** The user's "run it now": a run outside the schedule, which leaves the schedule as it was. */
export function runAutomationNow(world: World, id: string, requestId: string, options: FireOptions): Run {
  if (requestId.length > 100) throw new AutomationError("invalid", "Request id too long");
  return fire(world, getAutomation(world, id), { requestId: `auto-now:${requestId}`, slot: null, profile: options.profile, now: options.now ?? Date.now() });
}

/** The morning brief is there from the start, switched off, until the user has deleted it once. */
export function ensureTemplates(world: World, now: number = Date.now()): void {
  const made = world.db.prepare("SELECT 1 FROM core_events WHERE kind = 'automation.created' AND json_extract(payload, '$.template') = 'brief' LIMIT 1").get();
  if (!made) withDefaultActor("system", () => createAutomation(world, { template: "brief", schedule: { at: "07:30", days: [1, 2, 3, 4, 5, 6, 7] }, enabled: false }, now));
}
