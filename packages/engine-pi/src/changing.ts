/** What one of Pi's changing tools (edit, write) is about to do to a file: the diff the user approves, and the
 * lines it adds and removes for the receipt. Paths are resolved the way looking.ts does, symlinks included, so a
 * link inside the project to a file outside it counts as outside.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { inside, real } from "./looking.ts";

export const CHANGERS: Readonly<Record<string, string>> = { edit: "Edit file", write: "Write file" };

export interface Change {
  /** Resolved, absolute. */
  path: string;
  /** As a step and a receipt name it: from the project root inside it, in full outside. */
  shown: string;
  inProject: boolean;
  /** The file does not exist yet. */
  created: boolean;
  /** A unified diff of the change, or null when it cannot be worked out beforehand (the edit's text is not found). */
  patch: string | null;
  added: number;
  removed: number;
}

/** Lines a unified patch adds and removes. */
export function countPatch(patch: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** The file's new content after an edit's replacements (each `oldText` must be found), or null. */
function edited(content: string, edits: unknown): string | null {
  if (!Array.isArray(edits) || !edits.length) return null;
  let next = content.replace(/\r\n/g, "\n");
  for (const edit of edits as Array<{ oldText?: unknown; newText?: unknown }>) {
    const from = String(edit?.oldText ?? "").replace(/\r\n/g, "\n"), to = String(edit?.newText ?? "");
    const at = from ? next.indexOf(from) : -1;
    if (at < 0) return null;
    next = next.slice(0, at) + to + next.slice(at + from.length);
  }
  return next;
}

export function change(name: string, input: Record<string, unknown>, places: { root: string | null; cwd: string }): Change {
  const path = real(resolve(places.root ?? places.cwd, String(input.path ?? "")));
  const inProject = places.root !== null && inside(places.root, path);
  const shown = inProject ? relative(places.root!, path) : path;
  const created = !existsSync(path);
  let before = "";
  try { if (!created) before = readFileSync(path, "utf8"); } catch { /* unreadable: no diff */ }
  const after = name === "write" ? String(input.content ?? "") : edited(before, input.edits);
  const patch = after === null ? null : generateUnifiedPatch(shown, created ? "" : before.replace(/\r\n/g, "\n"), after);
  return { path, shown, inProject, created, patch, ...(patch ? countPatch(patch) : { added: 0, removed: 0 }) };
}
