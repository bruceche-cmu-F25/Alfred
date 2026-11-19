/** A development session's folder as git sees it: the snapshot it started from, what has changed since, and one
 * file's diff (docs/design/dev-mode.md 4.5). Towards the user's repository it only adds: `git stash create` makes a
 * commit object of the working tree without touching the tree, the index's contents, a branch or the stash, and one
 * ref under `refs/alfred/snapshots/` points at that commit, because git deletes a commit nothing points at.
 * A folder that is not a git repository has no snapshot; its changes are the session's own receipts.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

export interface ChangedFile { path: string; added: number; removed: number; created: boolean }
export interface WorkspaceChanges {
  /** The current branch, when it is a git repository. */
  branch: string | null;
  base: string | null;
  files: ChangedFile[];
}

function git(root: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      // `git diff --no-index` exits 1 when the files differ; its output is still the diff.
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ ok: !error || (code === 1 && !!stdout), out: String(stdout) });
    });
  });
}

/** Where the snapshots of working trees are kept from git's garbage collection. */
export const SNAPSHOT_REFS = "refs/alfred/snapshots/";

/** The snapshot a session's changes are measured against: the working tree as it is now, or HEAD when it is clean.
 * Null when the folder is not in a git repository (or has no commit yet). */
export async function snapshot(root: string): Promise<string | null> {
  if (!(await git(root, ["rev-parse", "--is-inside-work-tree"])).ok) return null;
  const stash = await git(root, ["stash", "create"]);
  const id = stash.ok ? stash.out.trim() : "";
  if (/^[0-9a-f]{7,64}$/.test(id)) {
    // Nothing points at this commit, so `git gc` would delete it and the session would lose what it started from.
    await git(root, ["update-ref", `${SNAPSHOT_REFS}${id}`, id]);
    return id;
  }
  const head = await git(root, ["rev-parse", "HEAD"]);
  return head.ok && /^[0-9a-f]{7,64}$/.test(head.out.trim()) ? head.out.trim() : null;
}

/** A path inside the project, given relative to it; null for anything that would leave it. */
function inProject(root: string, path: string): string | null {
  if (!path || isAbsolute(path)) return null;
  const clean = normalize(path);
  return clean === ".." || clean.startsWith(`..${sep}`) ? null : clean;
}

const lines = (text: string) => text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;

/** What changed in the project since the session's snapshot. `written`: files the session itself changed (its
 * receipts), which is all there is outside git and adds the new files git does not track yet. */
export async function workspaceChanges(root: string, base: string | null, written: ChangedFile[]): Promise<WorkspaceChanges> {
  const branchOut = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchOut.ok ? branchOut.out.trim() || null : null;
  if (!base) return { branch, base, files: merged(written) };
  const numstat = await git(root, ["diff", "--numstat", "--relative", base, "--", "."]);
  if (!numstat.ok) return { branch, base, files: merged(written) };
  const files = new Map<string, ChangedFile>();
  for (const row of numstat.out.split("\n")) {
    const [added, removed, ...rest] = row.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    files.set(path, { path, added: Number(added) || 0, removed: Number(removed) || 0, created: false });
  }
  // New files are untracked, so git's diff leaves them out: take the ones this session wrote, counted as they are now.
  for (const file of written) {
    const path = inProject(root, file.path);
    if (!path || files.has(path) || !file.created) continue;
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const tracked = await git(root, ["ls-files", "--error-unmatch", "--", path]);
    if (tracked.ok) continue;
    let count = 0;
    try { count = lines(readFileSync(full, "utf8")); } catch { /* unreadable */ }
    files.set(path, { path, added: count, removed: 0, created: true });
  }
  return { branch, base, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/** One file's diff against the snapshot (a new file against nothing). Null when there is no snapshot or the path leaves the project. */
export async function workspaceDiff(root: string, base: string | null, path: string): Promise<string | null> {
  const clean = inProject(root, path);
  if (!base || !clean) return null;
  const tracked = await git(root, ["ls-files", "--error-unmatch", "--", clean]);
  const inBase = await git(root, ["cat-file", "-e", `${base}:${(await prefix(root)) + clean.split(sep).join("/")}`]);
  if (tracked.ok || inBase.ok) {
    const diff = await git(root, ["diff", "--relative", base, "--", clean]);
    return diff.ok ? diff.out : null;
  }
  if (!existsSync(join(root, clean))) return null;
  const fresh = await git(root, ["diff", "--no-index", "--", "/dev/null", clean]);
  return fresh.ok ? fresh.out : null;
}

/** The project folder's path inside its repository ("" at the top), for naming a file in a commit. */
async function prefix(root: string): Promise<string> {
  const out = await git(root, ["rev-parse", "--show-prefix"]);
  return out.ok ? out.out.trim() : "";
}

/** One entry per path, the latest kept (a file written twice counts as it was last). */
function merged(written: ChangedFile[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const file of written) {
    const before = byPath.get(file.path);
    byPath.set(file.path, before ? { path: file.path, added: before.added + file.added, removed: before.removed + file.removed, created: before.created || file.created } : file);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
