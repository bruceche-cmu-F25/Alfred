/** Messages between the home node and an engine worker process.
 *
 * The model runs in the worker; Alfred's tools run in the home node, because
 * they write the world under the run's lease. So a tool call travels to the
 * home node and its result comes back. One worker handles one run at a time.
 */
import type { EngineRequest, FileChange, Workspace } from "@alfred/core";

/** A tool as the worker sees it: its description only. */
export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RunJob {
  /** Opaque to the worker: a key for the conversation's session. */
  thread: string;
  instructions: string;
  /** The user's turn, with today's date. */
  prompt: string;
  /** Earlier turns, for a session that starts empty (a conversation older than its session). */
  history: string | null;
  tools: ToolSpec[];
  /** `provider/model` and thinking level for this conversation; absent for Pi's defaults. */
  model?: string;
  thinking?: string;
  /** A development session's project folder: the session works there, with the file tools its access allows. */
  workspace?: Workspace;
}

export interface ModelInfo { id: string; provider: string; name: string; reasoning: boolean; contextWindow?: number }
export interface UsageInfo {
  model?: string; thinking?: string; tokens?: number; contextWindow?: number; percent?: number;
  /** This turn alone: tokens in and out, cache reads and writes, cost in dollars, and how long it took. */
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; durationMs?: number;
}

export type ExternalStep = { id: string; tool: string; label: string; about?: string; status: "started" | "done" | "failed" | "declined" };

export type ToParent =
  | { type: "tool"; run: string; call: string; name: string; params: Record<string, unknown> }
  /** The engine's own tools (MCP, read): ask the user, show a step, keep a receipt. */
  | { type: "allow"; run: string; call: string; question: string; detail?: string; always?: boolean }
  /** A file in the session's project was changed (edit, write): a receipt. */
  | { type: "changed"; run: string; file: FileChange }
  | { type: "step"; run: string; step: ExternalStep }
  | { type: "receipt"; run: string; tool: string; label: string; about?: string }
  | { type: "text"; run: string; text: string }
  | { type: "usage"; run: string; usage: UsageInfo }
  | { type: "steered"; run: string; ok: boolean }
  | { type: "models_result"; id: string; models: ModelInfo[]; error?: string }
  | { type: "done"; run: string; reply: string }
  | { type: "error"; run: string; message: string; code?: string };

export type ToWorker =
  | { type: "run"; run: string; job: RunJob }
  | { type: "tool_result"; run: string; call: string; ok: true; text: string }
  | { type: "tool_result"; run: string; call: string; ok: false; error: string }
  | { type: "allow_result"; run: string; call: string; allowed: boolean; always?: boolean }
  | { type: "abort"; run: string }
  /** The user's words, into the turn now running. */
  | { type: "steer"; run: string; text: string }
  /** Close this conversation's warm session: another worker takes it over. */
  | { type: "release"; thread: string }
  | { type: "models"; id: string }
  /** Close every session (and its MCP servers), then exit. */
  | { type: "shutdown" };

function weekday(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { weekday: "long" });
}

/** The user's turn as the model reads it: the date, what they were looking at (context only), then their words. */
export function composePrompt(request: Pick<EngineRequest, "today" | "timezone" | "goal" | "context">): string {
  const lines = [`Today is ${request.today} (${weekday(request.today)}), timezone ${request.timezone}.`];
  const context = request.context;
  if (context) {
    const page = context.title ? `${context.title} (${context.view})` : context.view;
    lines.push(`The user is looking at the ${page} page${context.summary ? `: ${context.summary}` : ""}.${context.selection ? ` Selected: ${context.selection.title ?? context.selection.id} (${context.selection.id}).` : ""} This is context, not a request.`);
  }
  return `${lines.join("\n")}\n\n${request.goal}`;
}

/** Earlier turns, only for a session that does not have them yet. Context only. */
export function composeHistory(request: Pick<EngineRequest, "history">): string | null {
  if (!request.history.length) return null;
  return [
    "Earlier in this conversation (context only; do not act on it again):",
    ...request.history.map((turn) => `${turn.role === "user" ? "User" : "Alfred"}: ${turn.text}`),
  ].join("\n");
}
