/** The module contract. A module is one piece of the user's life (todos, a
 * calendar, a daily brief): its business rules as operations, the agent tools
 * that reach them, its tables, and what devices need to draw it.
 *
 * Modules are first-party code with full Node privileges; installing one means
 * trusting its code. Third parties extend Alfred through MCP and skills instead.
 */
import {
  runCommand, withCoreContext, type Actor, type Migration, type RunTool, type World,
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

/** Tools every run gets from the harness itself: asking the user, and
 * opening a module's view on the user's device.
 */
export function assistantTools(modules: readonly AlfredModule[]): RunTool[] {
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
