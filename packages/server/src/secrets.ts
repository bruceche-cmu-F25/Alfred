/** Secrets (account tokens, keys) live in the macOS keychain, never in the world
 * database, a config file or a log. On other systems, and when
 * ALFRED_SECRETS=file (tests), a 0600 JSON file in the data directory stands in.
 *
 * Values go to the `security` tool on its standard input, never in its
 * arguments (which other processes can read), base64-encoded so any text
 * survives its parsing.
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SecretStore {
  readonly kind: "keychain" | "file";
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const NAME = /^[A-Za-z0-9:@._+-]{1,200}$/;
const SERVICE = /^[A-Za-z0-9 ._-]{1,64}$/;
const NOT_FOUND = 44;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`Invalid secret name: ${name}`);
}

function security(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (input === undefined) {
      execFile("security", args, { timeout: 10_000 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        if (error && code === -1) reject(error);
        else resolve({ code, stdout, stderr });
      });
      return;
    }
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input);
  });
}

export function keychainStore(service = process.env.ALFRED_KEYCHAIN_SERVICE || "Alfred"): SecretStore {
  if (!SERVICE.test(service)) throw new Error(`Invalid keychain service: ${service}`);
  const read = async (name: string) => {
    checkName(name);
    const { code, stdout, stderr } = await security(["find-generic-password", "-s", service, "-a", name, "-w"]);
    if (code === NOT_FOUND) return undefined;
    if (code !== 0) throw new Error(`Keychain read failed: ${stderr.trim()}`);
    return Buffer.from(stdout.trim(), "base64").toString("utf8");
  };
  return {
    kind: "keychain",
    get: read,
    async set(name, value) {
      checkName(name);
      const encoded = Buffer.from(value, "utf8").toString("base64");
      // Interactive mode reads the command, secret included, from standard input.
      await security(["-i"], `add-generic-password -U -s "${service}" -a "${name}" -w ${encoded}\n`);
      // `security -i` exits 0 even when a command fails, so check that it landed.
      if ((await read(name)) !== value) throw new Error("Keychain write failed");
    },
    async delete(name) {
      checkName(name);
      const { code, stderr } = await security(["delete-generic-password", "-s", service, "-a", name]);
      if (code !== 0 && code !== NOT_FOUND) throw new Error(`Keychain delete failed: ${stderr.trim()}`);
    },
  };
}

export function fileStore(path: string): SecretStore {
  const load = (): Record<string, string> => {
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>; } catch { return {}; }
  };
  const save = (data: Record<string, string>) => {
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  };
  return {
    kind: "file",
    async get(name) { checkName(name); return load()[name]; },
    async set(name, value) { checkName(name); save({ ...load(), [name]: value }); },
    async delete(name) { checkName(name); const data = load(); delete data[name]; save(data); },
  };
}

export function defaultSecretStore(dataDir: string): SecretStore {
  return process.platform === "darwin" && process.env.ALFRED_SECRETS !== "file" ? keychainStore() : fileStore(join(dataDir, "secrets.json"));
}
