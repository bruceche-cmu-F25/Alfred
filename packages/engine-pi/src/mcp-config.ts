/** Alfred's MCP servers: `<config>/mcp.json`, in the format Pi, Claude Desktop
 * and other MCP clients use ({ "mcpServers": { name: { command, args, env } |
 * { url, headers } } }). `${VAR}` placeholders are resolved by Pi when it
 * connects. Invalid entries are skipped and reported; they never stop the rest.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface McpServerEntry {
  name: string;
  config: Record<string, unknown>;
  source: string;
  scope: "global";
}
export interface LoadedMcpConfig { servers: McpServerEntry[]; errors: string[] }

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stringRecord = (value: unknown) => record(value) && Object.values(value).every((item) => typeof item === "string");

export function loadAlfredMcpConfig(dir: string): LoadedMcpConfig {
  const path = join(dir, "mcp.json");
  const result: LoadedMcpConfig = { servers: [], errors: [] };
  if (!existsSync(path)) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    result.errors.push(`${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    return result;
  }
  const servers = record(parsed) ? parsed.mcpServers : undefined;
  if (!record(servers)) {
    result.errors.push(`${path}: expected { "mcpServers": { ... } }`);
    return result;
  }
  for (const [name, config] of Object.entries(servers)) {
    const problem = !NAME.test(name) ? "names use letters, digits, - and _"
      : !record(config) ? "an entry is an object"
      : typeof config.command !== "string" && typeof config.url !== "string" ? "needs a command or a url"
      : config.args !== undefined && !strings(config.args) ? "args is a list of strings"
      : config.env !== undefined && !stringRecord(config.env) ? "env values are strings"
      : config.headers !== undefined && !stringRecord(config.headers) ? "header values are strings"
      : config.type === "sse" ? "the SSE transport is not supported; use the server's streamable HTTP URL"
      : null;
    if (problem) { result.errors.push(`${path}: server "${name}": ${problem}`); continue; }
    result.servers.push({ name, config: config as Record<string, unknown>, source: path, scope: "global" });
  }
  return result;
}
