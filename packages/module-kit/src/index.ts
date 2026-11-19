/** The module contract. A module is one piece of the user's life (todos, a
 * calendar, a daily brief): its business rules as operations, the agent tools
 * that reach them, its tables, and what devices need to draw it.
 *
 * Modules are first-party code with full Node privileges; installing one means
 * trusting its code. Third parties extend Alfred through MCP and skills instead.
 */
import {
  coreContext, getRun, openProposal, runCommand, withCoreContext, type Actor, type Migration, type ProposalStep, type RunTool, type World,
  automationName, createAutomation, listAutomations, updateAutomation, userLocale, type AutomationView,
} from "@alfred/core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export { Type, type Static, type TSchema };

/** How much consent an operation needs (ARCHITECTURE.md §5.2). */
export const PERMISSION_LEVELS = ["read", "local", "batch", "irreversible"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
/** What an unattended run may do without asking. */
export const RUN_LEVELS: readonly PermissionLevel[] = ["read", "local"];

/** A domain operation a device invokes directly (a click, an edit). */
export interface ModuleOp<P extends TSchema = TSchema> {
  /** `<module>.<verb>`, for example `todo.complete`. */
  name: string;
  level: PermissionLevel;
  input: P;
  /** Synchronous: it opens its own world transaction. Returns JSON. */
  run(world: World, input: Static<P>): unknown;
}

/** An operation as an agent reaches it: described for a model, answered in text. */
export interface ModuleTool<P extends TSchema = TSchema> {
  /** `<module>_<verb>`, for example `todo_add`. */
  name: string;
  label: string;
  description: string;
  level: PermissionLevel;
  parameters: P;
  execute(world: World, params: Static<P>): string;
  /** What one call is about, shown as a step ("Hand in report"). */
  describe?(world: World, params: Static<P>): string;
  /** For `irreversible` tools: the question that asks the user to allow this one call. */
  confirm?(world: World, params: Static<P>): string;
  /**
   * For tools a run may propose instead of doing: the device operation this call stands for, pinned to the exact
   * records it names now (ids and revisions, not a title to search later), and the subjects it touches
   * (`todo:<id>`), so the proposal goes stale if they change. Tools without it cannot be proposed.
   */
  pin?(world: World, params: Static<P>): { op: string; input: unknown; subjects?: string[]; preview?: string } | { error: string };
}

/** A view a device can open for a module: a pane beside the conversation, or a page. */
export interface ModuleView {
  /** Unique within the module, e.g. `list`. */
  id: string;
  title: string;
}

export interface AlfredModule {
  /** Lowercase; prefixes its ops, tools, event kinds and tables. */
  id: string;
  title: string;
  migrations: readonly Migration[];
  ops: readonly ModuleOp[];
  tools: readonly ModuleTool[];
  /** Views devices know how to draw from the snapshot. */
  views?: readonly ModuleView[];
  /** How a run should use this module's tools. Appended to the run's instructions. */
  guidance?: string;
  /** What a device needs to draw this module right now. JSON. */
  snapshot?(world: World): unknown;
}

/** Keeps each op's and tool's parameter types while building a module. */
export const defineOp = <P extends TSchema>(op: ModuleOp<P>): ModuleOp => op as unknown as ModuleOp;
export const defineTool = <P extends TSchema>(tool: ModuleTool<P>): ModuleTool => tool as unknown as ModuleTool;

export function defineModule(module: AlfredModule): AlfredModule {
  if (!/^[a-z][a-z0-9]{0,31}$/.test(module.id)) throw new Error(`Invalid module id: ${module.id}`);
  for (const migration of module.migrations) {
    if (!migration.id.startsWith(`${module.id}:`)) throw new Error(`Migration ${migration.id} must be named ${module.id}:<n>`);
  }
  for (const op of module.ops) {
    if (!op.name.startsWith(`${module.id}.`)) throw new Error(`Op ${op.name} must be named ${module.id}.<verb>`);
  }
  for (const tool of module.tools) {
    if (!tool.name.startsWith(`${module.id}_`)) throw new Error(`Tool ${tool.name} must be named ${module.id}_<verb>`);
  }
  return module;
}

export class OpInputError extends Error {
  override name = "OpInputError";
}

function checked<P extends TSchema>(schema: P, input: unknown, what: string): Static<P> {
  if (Value.Check(schema, input)) return input as Static<P>;
  const first = [...Value.Errors(schema, input)][0];
  throw new OpInputError(`Invalid ${what}${first ? `: ${first.instancePath || "input"} ${first.message}` : ""}`);
}

export class UnknownOpError extends Error {
  override name = "UnknownOpError";
  constructor(name: string) { super(`No such operation: ${name}`); }
}

/** A device's command. Runs at most once per request id (core `runCommand`). */
export function invokeOp(
  world: World,
  modules: readonly AlfredModule[],
  request: { op: string; requestId: string; input: unknown; actor?: Actor },
): { result: unknown; replayed: boolean } {
  const op = modules.flatMap((module) => module.ops).find((candidate) => candidate.name === request.op);
  if (!op) throw new UnknownOpError(request.op);
  const input = checked(op.input, request.input ?? {}, `input for ${op.name}`);
  return withCoreContext({ actor: request.actor ?? "user" }, () =>
    runCommand(world, { requestId: request.requestId, command: op.name, input }, () => op.run(world, input)));
}

/** The tools a run may use, bound to the world. Code decides this, never the
 * model: `levels` run directly; `askFor` levels run only after the user allows
 * each call (the core asks). Everything else is not offered at all.
 */
export function runTools(
  world: World,
  modules: readonly AlfredModule[],
  policy: { levels?: readonly PermissionLevel[]; askFor?: readonly PermissionLevel[] } = {},
): RunTool[] {
  const levels = policy.levels ?? RUN_LEVELS;
  const askFor = policy.askFor ?? ["irreversible"];
  return modules.flatMap((module) => module.tools).filter((tool) => levels.includes(tool.level) || askFor.includes(tool.level)).map((tool) => {
    const parse = (params: Record<string, unknown>) => checked(tool.parameters, params, `parameters for ${tool.name}`);
    const safely = (text: () => string | undefined) => { try { return text(); } catch { return undefined; } };
    const runTool: RunTool = {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
      execute: (params) => tool.execute(world, parse(params)),
      ...(tool.describe ? { describe: (params) => safely(() => tool.describe!(world, parse(params))) ?? "" } : {}),
    };
    if (!levels.includes(tool.level)) {
      runTool.permission = (params) => safely(() => tool.confirm?.(world, parse(params))) ?? `${tool.label}？`;
    }
    return runTool;
  });
}

/** Runs one proposal step as the device operation it is, with the same input checks as a click. Throws on failure
 * (including an operation that answers with `{ error }`), so the proposal's steps roll back together. */
export function applyStep(world: World, modules: readonly AlfredModule[], step: ProposalStep): unknown {
  const op = modules.flatMap((module) => module.ops).find((candidate) => candidate.name === step.op);
  if (!op) throw new UnknownOpError(step.op);
  const result = op.run(world, checked(op.input, step.input, `input for ${op.name}`));
  if (result && typeof result === "object" && typeof (result as { error?: unknown }).error === "string") throw new Error((result as { error: string }).error);
  return result;
}

/** Tools every run gets from the harness itself: asking the user, proposing changes for later, and
 * opening a module's view on the user's device.
 */
export function assistantTools(world: World, modules: readonly AlfredModule[]): RunTool[] {
  const tools: RunTool[] = [{
    name: "ask_user",
    label: "Ask",
    description: "Ask the user a short question when you cannot go on without their choice. Offer 2–4 short options when you can. Returns their answer. Use it only when a wrong guess would matter.",
    parameters: Type.Object({
      question: Type.String({ description: "One short question, in the user's language" }),
      options: Type.Optional(Type.Array(Type.String(), { maxItems: 6, description: "Suggested answers" })),
    }) as unknown as Record<string, unknown>,
    describe: (params) => String(params.question ?? "").slice(0, 120),
    async execute(params, _signal, context) {
      if (!context) throw new Error("ask_user needs a run");
      const answer = await context.ask({ question: String(params.question ?? ""), options: Array.isArray(params.options) ? params.options.map(String) : [] });
      return `The user answered: ${answer}`;
    },
  }];
  const proposable = modules.flatMap((module) => module.tools).filter((tool) => tool.pin && tool.level !== "read");
  if (proposable.length) {
    tools.push({
      name: "propose",
      label: "Propose",
      description: [
        "Prepare changes for the user to approve later, instead of making them now. Use it for anything the user should decide",
        "(deleting, several changes at once, anything you are unsure they want), or when they asked you to suggest rather than do.",
        "The user sees your title and summary in their inbox, with the exact steps, and can accept, decline or ask for a change;",
        "accepting runs exactly these steps, once. Do not also make these changes yourself. After proposing you can finish and say what you proposed.",
        `Tools you can propose: ${proposable.map((tool) => tool.name).join(", ")} (with the same parameters as calling them).`,
      ].join(" "),
      parameters: Type.Object({
        title: Type.String({ maxLength: 120, description: "The decision as a short question in the user's language, e.g. 删掉 3 条逾期很久的待办？" }),
        summary: Type.String({ maxLength: 1200, description: "What will change and why, briefly, in the user's language" }),
        calls: Type.Array(Type.Object({
          tool: Type.Union(proposable.map((tool) => Type.Literal(tool.name))),
          params: Type.Record(Type.String(), Type.Unknown(), { description: "The tool's parameters" }),
        }), { minItems: 1, maxItems: 20 }),
      }) as unknown as Record<string, unknown>,
      describe: (params) => String(params.title ?? "").slice(0, 120),
      execute(params) {
        const calls = Array.isArray(params.calls) ? params.calls as Array<{ tool?: unknown; params?: unknown }> : [];
        if (!calls.length) return "Give at least one call to propose.";
        const steps: ProposalStep[] = [];
        const subjects: string[] = [];
        for (const [index, call] of calls.entries()) {
          const tool = proposable.find((candidate) => candidate.name === call.tool);
          if (!tool) return `Call ${index + 1}: ${String(call.tool)} cannot be proposed. Use one of: ${proposable.map((candidate) => candidate.name).join(", ")}.`;
          let parsed: unknown;
          try { parsed = checked(tool.parameters, call.params ?? {}, `parameters for ${tool.name}`); } catch (error) { return `Call ${index + 1}: ${(error as Error).message}`; }
          const pinned = tool.pin!(world, parsed as never);
          if ("error" in pinned) return `Call ${index + 1}: ${pinned.error}`;
          const op = modules.flatMap((module) => module.ops).find((candidate) => candidate.name === pinned.op);
          if (!op) return `Call ${index + 1}: no operation ${pinned.op}.`;
          try { checked(op.input, pinned.input, `input for ${op.name}`); } catch (error) { return `Call ${index + 1}: ${(error as Error).message}`; }
          // What the user reads: the module's own words for the pinned step, else the tool and what it names.
          let preview = pinned.preview ?? tool.label;
          if (!pinned.preview) try { preview = tool.describe ? `${tool.label}：${tool.describe(world, parsed as never)}` : tool.label; } catch { /* keep the label */ }
          steps.push({ op: pinned.op, input: pinned.input, preview });
          subjects.push(...(pinned.subjects ?? []));
        }
        const run = coreContext()?.run;
        const conversationId = run ? getRun(world, run.id).run.conversationId : null;
        const proposal = openProposal(world, { title: String(params.title ?? ""), summary: String(params.summary ?? ""), steps, subjects, conversationId });
        return `Proposed "${proposal.title}" (${steps.length} step${steps.length > 1 ? "s" : ""}). It waits in the user's inbox for their decision; nothing has changed yet.`;
      },
    });
  }
  // The user's automations, so "every Monday morning, go over my todos" can be said, not only clicked.
  const days = Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, description: "Weekdays, 1 Monday to 7 Sunday; every day if left out" }));
  const at = Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Time of day, HH:MM, 24-hour, the user's local time" });
  const sayAutomation = (automation: AutomationView) => [
    `${automation.id}: ${automationName(automation, userLocale(world))}`,
    `${automation.schedule.days.length === 7 ? "every day" : `weekdays ${automation.schedule.days.join(",")}`} at ${automation.schedule.at}`,
    automation.enabled ? `on, next ${automation.nextAt}` : "off",
    ...(automation.goal ? [`does: ${automation.goal}`] : []),
  ].join(" | ");
  const attempt = (action: () => string) => { try { return action(); } catch (error) { return `Not done: ${(error as Error).message}`; } };
  tools.push({
    name: "automation_list",
    label: "Automations",
    description: "List the user's automations (what you do on your own on a schedule, like the morning brief): id, name, when, on or off, what each does.",
    parameters: Type.Object({}) as unknown as Record<string, unknown>,
    execute: () => listAutomations(world).map(sayAutomation).join("\n") || "No automations.",
  }, {
    name: "automation_add",
    label: "New automation",
    description: [
      "Make an automation: something you will do on your own, on a schedule, when the user asks for something recurring (\"every Monday morning, go over my todos\").",
      "Its runs are unattended: they read and make reversible changes, and propose anything else. It starts switched on.",
    ].join(" "),
    parameters: Type.Object({
      name: Type.String({ maxLength: 60, description: "A short name, in the user's language" }),
      goal: Type.String({ maxLength: 2000, description: "What to do each time, as the instruction you will be given then, in the user's language" }),
      at, days,
    }) as unknown as Record<string, unknown>,
    describe: (params) => String(params.name ?? "").slice(0, 60),
    execute: (params) => attempt(() => {
      const made = createAutomation(world, {
        name: String(params.name ?? ""), goal: String(params.goal ?? ""),
        schedule: { at: params.at, days: Array.isArray(params.days) ? params.days : [1, 2, 3, 4, 5, 6, 7] },
      });
      return `Made the automation "${made.name}" (${made.id}). It is on; the user can change or switch it off on the Automations page.`;
    }),
  }, {
    name: "automation_update",
    label: "Change automation",
    description: "Change one of the user's automations: rename it, reword what it does, move its time or days, or switch it on or off. Get its id from automation_list.",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String({ maxLength: 60 })),
      goal: Type.Optional(Type.String({ maxLength: 2000 })),
      at: Type.Optional(at), days,
      enabled: Type.Optional(Type.Boolean()),
    }) as unknown as Record<string, unknown>,
    describe: (params) => String(params.id ?? ""),
    execute: (params) => attempt(() => {
      const current = listAutomations(world).find((automation) => automation.id === params.id);
      if (!current) return `No automation ${String(params.id)}. Use automation_list.`;
      const changed = updateAutomation(world, current.id, {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.goal !== undefined ? { goal: params.goal } : {}),
        ...(params.at !== undefined || params.days !== undefined ? { schedule: { at: params.at ?? current.schedule.at, days: params.days ?? current.schedule.days } } : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      });
      return `Changed: ${sayAutomation({ ...current, ...changed })}.`;
    }),
  });
  const views = modules.flatMap((module) => (module.views ?? []).map((view) => ({ key: `${module.id}.${view.id}`, module: module.id, view: view.id, title: view.title })));
  if (views.length) {
    tools.push({
      name: "show_view",
      label: "Show",
      description: `Open a view beside the conversation on the user's screen, when the answer is easier to see than to read. Views: ${views.map((view) => `${view.key} (${view.title})`).join(", ")}.`,
      parameters: Type.Object({
        view: Type.Union(views.map((view) => Type.Literal(view.key))),
      }) as unknown as Record<string, unknown>,
      describe: (params) => views.find((view) => view.key === params.view)?.title ?? "",
      execute(params, _signal, context) {
        const view = views.find((candidate) => candidate.key === params.view);
        if (!view) return `Unknown view. Use one of: ${views.map((candidate) => candidate.key).join(", ")}`;
        context?.note("view", { module: view.module, view: view.view });
        return `Shown ${view.title} to the user.`;
      },
    });
  }
  return tools;
}

export function moduleMigrations(modules: readonly AlfredModule[]): Migration[] {
  return modules.flatMap((module) => module.migrations);
}
