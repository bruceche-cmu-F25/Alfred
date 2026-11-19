#!/usr/bin/env node
/** alfred serve            run the home node (loopback only for now)
 *  alfred import-robin     copy Robin's todos into Alfred (read-only on Robin)
 *
 *  Options: --data-dir <dir>  --port <n>  --robin-dir <dir>  --dry-run  --check
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { createPiEngine } from "@alfred/engine-pi";
import { compareTodos, importTodos, readRobinTodos, robinDataDir, todoModule } from "@alfred/module-todo";
import { DEFAULT_PORT, defaultDataDir, defaultUiDir } from "./config.ts";
import { openHome } from "./home.ts";
import { createHttpServer } from "./http.ts";
import { GoogleConnections } from "./google.ts";
import { defaultSecretStore } from "./secrets.ts";

const MODULES = [todoModule];
const log = (message: string) => console.log(`[alfred] ${message}`);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
    port: { type: "string" },
    "robin-dir": { type: "string" },
    "dry-run": { type: "boolean" },
    check: { type: "boolean" },
  },
});
const dataDir = values["data-dir"] ?? defaultDataDir();
const command = positionals[0] ?? "serve";

if (command === "serve") {
  const port = Number(values.port ?? process.env.ALFRED_PORT ?? DEFAULT_PORT);
  // The model runs in worker processes; each conversation keeps its session under <data>/engine/sessions.
  // MCP servers come from <data>/mcp.json, skills from <data>/skills/.
  const engine = createPiEngine({ cwd: join(dataDir, "engine"), config: dataDir, log });
  // How long a locked screen counts as "away" before coming back is a return (default 10 minutes).
  const awayMinutes = Number(process.env.ALFRED_AWAY_MINUTES);
  const presence = Number.isFinite(awayMinutes) && awayMinutes > 0 ? { awayReturnMs: awayMinutes * 60_000 } : {};
  let home: ReturnType<typeof openHome>;
  try {
    home = openHome({ dataDir, engine, modules: MODULES, presence, log });
  } catch (error) {
    if (!(error instanceof Error && error.name === "AlreadyRunningError")) throw error;
    console.error(`[alfred] ${error.message}. Stop it first, or use another --data-dir.`);
    process.exit(1);
  }
  // Google accounts: tokens in the keychain, Alfred's own OAuth client from the data directory (or the default one).
  const google = new GoogleConnections({ dataDir, secrets: defaultSecretStore(dataDir), world: home.world, clientDirs: [...new Set([dataDir, defaultDataDir()])], log });
  const server = createHttpServer(home, { port, uiDir: defaultUiDir(), log, google });
  server.on("error", (error: NodeJS.ErrnoException) => {
    void engine.close();
    home.close();
    if (error.code === "EADDRINUSE") {
      console.error(`[alfred] Port ${port} is already in use (another Alfred, or something else). Stop it, or pick another port: npm start -- --port <n>`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, "127.0.0.1", () => {
    log(`home node on http://127.0.0.1:${port}  (data: ${dataDir})`);
    home.kick();
  });
  const stop = async () => {
    google.close();
    server.close();
    server.closeAllConnections();
    // Workers close their sessions (and MCP servers) before the world closes.
    await engine.close();
    home.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
} else if (command === "import-robin") {
  const { todos, from } = readRobinTodos(values["robin-dir"] ?? robinDataDir());
  log(`read ${todos.length} todo(s) from ${from} (read-only)`);
  if (values["dry-run"]) {
    log("dry run: nothing written");
    process.exit(0);
  }
  // Holds the home node lock: refuses while a home node is running on this data dir.
  const home = openHome({ dataDir, engine: { submit: () => Promise.reject(new Error("no engine")) }, modules: MODULES, log });
  try {
    if (!values.check) {
      const result = importTodos(home.world, todos, "robin");
      log(`imported ${result.imported}, skipped ${result.skipped} already present`);
    }
    const comparison = compareTodos(home.world, todos);
    log(`compared with Robin: ${comparison.same} same, ${comparison.differ.length} differ, ${comparison.missing.length} missing, ${comparison.extra.length} only in Alfred`);
    process.exitCode = comparison.differ.length || comparison.missing.length ? 1 : 0;
  } finally {
    home.close();
  }
} else {
  console.error(`Unknown command: ${command}\nUsage: alfred serve | alfred import-robin [--dry-run] [--check]`);
  process.exit(2);
}
