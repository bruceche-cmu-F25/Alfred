/** A device's command (a click, a typed edit) runs at most once per request
 * id. A retried request gets the original result back; reusing an id for a
 * different command is refused. The record commits with the change itself.
 */
import { createHash } from "node:crypto";
import { iso } from "./ids.ts";
import { REQUEST_ID } from "./runs.ts";
import type { World } from "./world.ts";

export class CommandConflictError extends Error {
  override name = "CommandConflictError";
  constructor() { super("This request id was already used for a different command"); }
}

const hashOf = (command: string, input: unknown) => createHash("sha256").update(JSON.stringify({ command, input: input ?? null })).digest("hex");

/** What this request id already did, or null when it has not run. For a command that has slow work to do before its
 * change (a transaction cannot wait): it asks first, so a retry does not do that work again. */
export function commandReplay<T>(world: World, request: { requestId: string; command: string; input: unknown }): { result: T } | null {
  if (!REQUEST_ID.test(request.requestId)) throw new Error("Invalid request id");
  const existing = world.db.prepare("SELECT request_hash, result FROM core_commands WHERE request_id = ?").get(request.requestId);
  if (!existing) return null;
  if (existing.request_hash !== hashOf(request.command, request.input)) throw new CommandConflictError();
  return { result: JSON.parse(existing.result as string) as T };
}

export function runCommand<T>(
  world: World,
  request: { requestId: string; command: string; input: unknown; now?: number },
  action: () => T,
): { result: T; replayed: boolean } {
  if (!REQUEST_ID.test(request.requestId)) throw new Error("Invalid request id");
  const hash = hashOf(request.command, request.input);
  return world.tx((db) => {
    const existing = db.prepare("SELECT request_hash, result FROM core_commands WHERE request_id = ?").get(request.requestId);
    if (existing) {
      if (existing.request_hash !== hash) throw new CommandConflictError();
      return { result: JSON.parse(existing.result as string) as T, replayed: true };
    }
    const result = action();
    db.prepare("INSERT INTO core_commands (request_id, request_hash, command, at, result) VALUES (?, ?, ?, ?, ?)")
      .run(request.requestId, hash, request.command, iso(request.now ?? Date.now()), JSON.stringify(result ?? null));
    return { result, replayed: false };
  });
}
