import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 7480;

/** Where the world lives. Never inside the repository. */
export function defaultDataDir(): string {
  if (process.env.ALFRED_DATA_DIR) return resolve(process.env.ALFRED_DATA_DIR);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Alfred");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "alfred");
}

/** The built interface, next to this package in the workspace. */
export function defaultUiDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}
