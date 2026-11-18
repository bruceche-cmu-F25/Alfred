/** Messages between the home node and an engine worker process.
 *
 * The model runs in the worker; Alfred's tools run in the home node, because
 * they write the world under the run's lease. So a tool call travels to the
 * home node and its result comes back. One worker handles one run at a time.
 */
import type { EngineRequest } from "@alfred/core";

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
}

export type ToParent =
  | { type: "tool"; run: string; call: string; name: string; params: Record<string, unknown> }
  | { type: "text"; run: string; text: string }
  | { type: "done"; run: string; reply: string }
  | { type: "error"; run: string; message: string; code?: string };

export type ToWorker =
  | { type: "run"; run: string; job: RunJob }
  | { type: "tool_result"; run: string; call: string; ok: true; text: string }
  | { type: "tool_result"; run: string; call: string; ok: false; error: string }
  | { type: "abort"; run: string };

function weekday(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { weekday: "long" });
}

/** The user's turn as the model reads it. */
export function composePrompt(request: Pick<EngineRequest, "today" | "timezone" | "goal">): string {
  return `Today is ${request.today} (${weekday(request.today)}), timezone ${request.timezone}.\n\n${request.goal}`;
}

/** Earlier turns, only for a session that does not have them yet. Context only. */
export function composeHistory(request: Pick<EngineRequest, "history">): string | null {
  if (!request.history.length) return null;
  return [
    "Earlier in this conversation (context only; do not act on it again):",
    ...request.history.map((turn) => `${turn.role === "user" ? "User" : "Alfred"}: ${turn.text}`),
  ].join("\n");
}
