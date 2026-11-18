/** The world: one SQLite file that holds every state change and the event
 * describing it. The home node is its only writer and keeps one connection.
 *
 * Transactions are synchronous. Do network or model work before opening one;
 * a domain change, its core event and anything derived from it (a receipt, a
 * notice, a command result) commit together or not at all.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  /** `<owner>:<n>`, for example `core:1` or `todo:1`. Applied once, in the order given. */
  id: string;
  sql: string;
}

export interface World {
  readonly path: string;
  /** Only for use inside `tx` or for reads that need no consistency across statements. */
  readonly db: DatabaseSync;
  /** Runs `action` in a transaction; nested calls become savepoints. Writers reserve before reading. */
  tx<T>(action: (db: DatabaseSync) => T): T;
  inTx(): boolean;
  /** Called after each outermost commit. Returns an unsubscribe function. */
  onCommit(listener: () => void): () => void;
  close(): void;
}

const MIGRATION_ID = /^[a-z][a-z0-9_-]*:\d+$/;

function synchronous<T>(value: T): T {
  if (value && typeof (value as { then?: unknown }).then === "function") {
    throw new Error("World transactions must be synchronous; do network work before opening one");
  }
  return value;
}

export function openWorld(path: string, migrations: readonly Migration[]): World {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  let depth = 0;
  let savepoints = 0;
  const listeners = new Set<() => void>();

  const world: World = {
    path,
    db,
    tx(action) {
      if (depth > 0) {
        const name = `sp_${++savepoints}`;
        db.exec(`SAVEPOINT ${name}`);
        depth++;
        try {
          const result = synchronous(action(db));
          db.exec(`RELEASE ${name}`);
          return result;
        } catch (error) {
          db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
          throw error;
        } finally {
          depth--;
        }
      }
      db.exec("BEGIN IMMEDIATE");
      depth = 1;
      let committed = false;
      try {
        const result = synchronous(action(db));
        db.exec("COMMIT");
        committed = true;
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth = 0;
        if (committed) for (const listener of listeners) {
          try { listener(); } catch { /* a listener must not undo a commit */ }
        }
      }
    },
    inTx: () => depth > 0,
    onCommit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      db.close();
    },
  };

  migrate(world, migrations);
  return world;
}

function migrate(world: World, migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (!MIGRATION_ID.test(migration.id)) throw new Error(`Invalid migration id: ${migration.id}`);
    if (seen.has(migration.id)) throw new Error(`Duplicate migration id: ${migration.id}`);
    seen.add(migration.id);
  }
  world.db.exec(`CREATE TABLE IF NOT EXISTS world_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const applied = new Set(world.db.prepare("SELECT id FROM world_migrations").all().map((row) => row.id as string));
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    world.tx((db) => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO world_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, new Date().toISOString());
    });
  }
}
