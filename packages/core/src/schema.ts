/** The core's own tables. Modules add theirs through their own migrations, in
 * the same database, so a module change and its core event share a transaction.
 */
import type { Migration } from "./world.ts";

export const RUN_STATES = [
  "queued", "running", "waiting_permission", "waiting_input",
  "cancelling", "completed", "failed", "cancelled", "interrupted",
] as const;
export const NOTICE_STATES = ["pending", "claimed", "presented", "acknowledged", "expired"] as const;
export const ACTORS = ["user", "alfred", "system"] as const;
export const PROPOSAL_STATES = ["open", "executed", "declined", "stale", "failed", "superseded", "expired"] as const;

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const object = (column: string) => `json_valid(${column}) AND json_type(${column}) = 'object'`;

export const CORE_MIGRATIONS: readonly Migration[] = [{
  id: "core:1",
  sql: `
CREATE TABLE core_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  at TEXT NOT NULL CHECK (length(at) > 0),
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*.[a-z]*' AND length(kind) <= 64),
  subject TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 160),
  run_id TEXT,
  actor TEXT CHECK (actor IS NULL OR actor IN (${list(ACTORS)})),
  payload TEXT NOT NULL CHECK (${object("payload")})
) STRICT;
CREATE INDEX core_events_subject ON core_events(subject, seq);
CREATE INDEX core_events_run ON core_events(run_id, seq);

CREATE TABLE core_runs (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL,
  conversation_id TEXT NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 64),
  goal TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 8000),
  profile TEXT NOT NULL CHECK (length(profile) BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK (state IN (${list(RUN_STATES)})),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_owner TEXT,
  lease_until TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  outcome TEXT CHECK (outcome IS NULL OR ${object("outcome")})
) STRICT;
CREATE INDEX core_runs_state ON core_runs(state, created_at);
CREATE INDEX core_runs_conversation ON core_runs(conversation_id, created_at);

CREATE TABLE core_notices (
  id TEXT PRIMARY KEY NOT NULL,
  event_seq INTEGER NOT NULL REFERENCES core_events(seq),
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*' AND length(kind) <= 64),
  state TEXT NOT NULL CHECK (state IN (${list(NOTICE_STATES)})),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_by TEXT,
  claim_until TEXT,
  expires_at TEXT,
  payload TEXT NOT NULL CHECK (${object("payload")})
) STRICT;
CREATE INDEX core_notices_state ON core_notices(state, created_at);

CREATE TABLE core_commands (
  request_id TEXT PRIMARY KEY NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL,
  command TEXT NOT NULL,
  at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (json_valid(result))
) STRICT;
`,
}, {
  // Conversations become threads of their own; a run may wait on a question to the user.
  id: "core:2",
  sql: `
CREATE TABLE core_conversations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;
CREATE INDEX core_conversations_updated ON core_conversations(updated_at);
INSERT INTO core_conversations (id, title, created_at, updated_at)
  SELECT r.conversation_id,
    (SELECT substr(f.goal, 1, 40) FROM core_runs f WHERE f.conversation_id = r.conversation_id ORDER BY f.created_at, f.rowid LIMIT 1),
    min(r.created_at), max(r.updated_at)
  FROM core_runs r GROUP BY r.conversation_id;
ALTER TABLE core_runs ADD COLUMN request TEXT CHECK (request IS NULL OR (json_valid(request) AND json_type(request) = 'object'));
`,
}, {
  // A conversation may choose its model and how hard it thinks; unset means the engine's default.
  id: "core:3",
  sql: `
ALTER TABLE core_conversations ADD COLUMN model TEXT CHECK (model IS NULL OR (length(model) BETWEEN 3 AND 200 AND instr(model, '/') > 1));
ALTER TABLE core_conversations ADD COLUMN thinking TEXT CHECK (thinking IS NULL OR thinking IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));
`,
}, {
  // Changes Alfred prepares that wait for the user's yes (proposals.ts).
  id: "core:4",
  sql: `
CREATE TABLE core_proposals (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK (state IN (${list(PROPOSAL_STATES)})),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(summary) <= 2000),
  steps TEXT NOT NULL CHECK (json_valid(steps) AND json_type(steps) = 'array' AND json_array_length(steps) BETWEEN 1 AND 20),
  subjects TEXT NOT NULL CHECK (json_valid(subjects) AND json_type(subjects) = 'array'),
  opened_seq INTEGER NOT NULL,
  run_id TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR (json_valid(outcome) AND json_type(outcome) = 'object'))
) STRICT;
CREATE INDEX core_proposals_state ON core_proposals(state, created_at);
`,
}, {
  // The user's preferences that are not secrets (settings.ts); each change is also a settings.changed event.
  id: "core:5",
  sql: `
CREATE TABLE core_settings (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
) STRICT;
`,
}, {
  // The page a request came from (runs.ts ViewContext): context for the engine, shown with the user's words.
  id: "core:6",
  sql: `
ALTER TABLE core_runs ADD COLUMN context TEXT CHECK (context IS NULL OR (json_valid(context) AND json_type(context) = 'object'));
`,
}, {
  // Paired devices (devices.ts): only a hash of each device's token is kept.
  id: "core:7",
  sql: `
CREATE TABLE core_devices (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('desktop', 'phone', 'browser')),
  via TEXT CHECK (via IS NULL OR length(via) <= 200),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  paired_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
) STRICT;
`,
}, {
  // Automations (automations.ts): rules that start a run on a schedule. A run they start says which (core_runs.automation_id).
  id: "core:8",
  sql: `
CREATE TABLE core_automations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 60),
  template TEXT CHECK (template IS NULL OR template IN ('brief')),
  goal TEXT CHECK (goal IS NULL OR length(goal) BETWEEN 1 AND 2000),
  schedule TEXT NOT NULL CHECK (json_valid(schedule) AND json_type(schedule) = 'object'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  conversation_id TEXT,
  last_slot TEXT,
  last_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (template IS NOT NULL OR (name IS NOT NULL AND goal IS NOT NULL))
) STRICT;
ALTER TABLE core_runs ADD COLUMN automation_id TEXT CHECK (automation_id IS NULL OR length(automation_id) BETWEEN 1 AND 64);
`,
}, {
  // Projects (projects.ts): folders Alfred may work in. A conversation in one is a development session, fixed at creation.
  id: "core:9",
  sql: `
CREATE TABLE core_projects (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024 AND substr(path, 1, 1) = '/'),
  created_at TEXT NOT NULL,
  trusted_at TEXT,
  removed_at TEXT
) STRICT;
CREATE UNIQUE INDEX core_projects_path ON core_projects(path) WHERE removed_at IS NULL;
ALTER TABLE core_conversations ADD COLUMN project_id TEXT CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 64);
`,
}];
