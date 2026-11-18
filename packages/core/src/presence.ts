/** Presence: is the user here, and did they just come back? This module only
 * knows WHEN a return happens and WHAT changed meanwhile, from the world's own
 * records. Ported from Robin's alfred-core/presence.ts, plus an explicit
 * `away` (the screen locked, the machine slept) from devices that can tell.
 *
 * Devices report `active` (real input, a window in use) and `away`. Activity is
 * kept as `presence.active` events, at most one per HEARTBEAT_MS, so "last seen"
 * spans every device. A report is a return when the user was away long enough:
 * after an explicit `away`, `awayReturnMs`; otherwise after `returnAfterMs` of
 * silence, or on a new local day. A return records `presence.returned` and one
 * `welcome` notice, in one transaction, claimed by the device that saw the user
 * come back. A second window, a reload or another device reporting a moment
 * later finds fresh presence and greets nobody.
 */
import type { DatabaseSync } from "node:sqlite";
import { appendEvent } from "./events.ts";
import { iso } from "./ids.ts";
import { createNotice, type Notice } from "./notices.ts";
import type { World } from "./world.ts";

export const PRESENCE_KINDS = ["active", "away"] as const;
export type PresenceKind = (typeof PRESENCE_KINDS)[number];

export interface PresenceOptions {
  /** Silence after which any report counts as a return. */
  returnAfterMs?: number;
  /** After an explicit `away`, how long before coming back counts as a return. */
  awayReturnMs?: number;
}
export const RETURN_AFTER_MS = 30 * 60_000;
export const AWAY_RETURN_MS = 10 * 60_000;
export const HEARTBEAT_MS = 3 * 60_000;
/** A welcome nobody saw within this long is stale; the next return makes a new one. */
export const WELCOME_TTL_MS = 2 * 60 * 60_000;
const CLAIM_MS = 60_000;

export interface AwayDigest {
  /** When the user was last here, and how long they were gone. */
  since: string;
  awayMs: number;
  /** Runs that finished while away. */
  runs: { completed: number; failed: number; interrupted: number; goals: string[] };
  /** World changes Alfred or the system made, by module (`todo`, …). Yours are not news. */
  changes: Record<string, number>;
  /** Notices that arrived while away and still wait (welcomes excluded). */
  waiting: number;
}
export interface PresenceResult { returned: boolean; notice: Notice | null }

const CLIENT = /^[A-Za-z0-9._:-]{1,80}$/;
const localDay = (ms: number) => new Date(ms).toDateString();

function digest(db: DatabaseSync, since: { seq: number; at: string }, now: number): AwayDigest {
  const runs = db.prepare(`SELECT state, goal FROM core_runs WHERE updated_at > ?
    AND state IN ('completed', 'failed', 'interrupted') ORDER BY updated_at`).all(since.at) as { state: string; goal: string }[];
  const changes: Record<string, number> = {};
  for (const row of db.prepare(`SELECT kind, sum(coalesce(json_extract(payload, '$.count'), 1)) AS n FROM core_events
    WHERE seq > ? AND kind NOT LIKE 'run.%' AND kind NOT LIKE 'presence.%' AND actor IN ('alfred', 'system') GROUP BY kind`)
    .all(since.seq) as { kind: string; n: number }[]) {
    const module = row.kind.split(".")[0];
    changes[module] = (changes[module] ?? 0) + row.n;
  }
  const waiting = db.prepare(`SELECT count(*) AS n FROM core_notices WHERE created_at > ? AND kind != 'welcome'
    AND state IN ('pending', 'claimed', 'presented')`).get(since.at) as { n: number };
  return {
    since: since.at,
    awayMs: now - Date.parse(since.at),
    runs: {
      completed: runs.filter((run) => run.state === "completed").length,
      failed: runs.filter((run) => run.state === "failed").length,
      interrupted: runs.filter((run) => run.state === "interrupted").length,
      goals: runs.filter((run) => run.state === "completed").slice(-3).map((run) => run.goal.slice(0, 80)),
    },
    changes,
    waiting: waiting.n,
  };
}

interface Seen { seq: number; at: number; atIso: string; kind: string }

function lastPresence(db: DatabaseSync, kind?: string): Seen | null {
  const row = db.prepare(`SELECT seq, at, kind FROM core_events WHERE subject = 'presence'
    AND kind IN ('presence.active', 'presence.away') AND (? IS NULL OR kind = ?) ORDER BY seq DESC LIMIT 1`).get(kind ?? null, kind ?? null);
  return row ? { seq: row.seq as number, at: Date.parse(row.at as string), atIso: row.at as string, kind: row.kind as string } : null;
}

/** Pure: given the last activity and the last presence signal, is a report at `now` a return?
 * With no history it is not: the clock starts, and the next real return greets.
 */
export function isReturn(lastActive: number | null, latest: { kind: string; at: number } | null, now: number, options: PresenceOptions = {}): boolean {
  if (lastActive === null || latest === null) return false;
  if (latest.kind === "presence.away") return now - latest.at >= (options.awayReturnMs ?? AWAY_RETURN_MS);
  return now - lastActive > (options.returnAfterMs ?? RETURN_AFTER_MS) || localDay(lastActive) !== localDay(now);
}

/** A device saw the user (`active`) or saw them go (`away`). Returns the
 * welcome notice when this report is a return.
 */
export function reportPresence(world: World, input: { clientId: string; kind: PresenceKind; now?: number } & PresenceOptions): PresenceResult {
  if (!CLIENT.test(input.clientId)) throw new Error("Invalid client id");
  if (!PRESENCE_KINDS.includes(input.kind)) throw new Error("Invalid presence kind");
  const now = input.now ?? Date.now();
  return world.tx((db) => {
    const latest = lastPresence(db);
    if (input.kind === "away") {
      if (latest?.kind !== "presence.away") {
        appendEvent(db, { kind: "presence.away", subject: "presence", actor: "user", runId: null, now, payload: { client: input.clientId } });
      }
      return { returned: false, notice: null };
    }
    const active = lastPresence(db, "presence.active");
    const returned = isReturn(active?.at ?? null, latest, now, input);
    if (!active || returned || latest?.kind === "presence.away" || now - active.at >= HEARTBEAT_MS) {
      appendEvent(db, { kind: "presence.active", subject: "presence", actor: "user", runId: null, now, payload: { client: input.clientId } });
    }
    if (!returned || !active) return { returned: false, notice: null };
    // Only the newest welcome matters; an older one nobody presented is stale.
    db.prepare(`UPDATE core_notices SET state = 'expired', updated_at = ?, claimed_by = NULL, claim_until = NULL
      WHERE kind = 'welcome' AND state IN ('pending', 'claimed')`).run(iso(now));
    // Away since the last activity, or since the explicit `away` if that came later.
    const since = latest && latest.kind === "presence.away" && latest.seq > active.seq ? latest : active;
    const away = digest(db, { seq: since.seq, at: since.atIso }, now);
    const event = appendEvent(db, { kind: "presence.returned", subject: "presence", actor: "system", runId: null, now, payload: { ...away, client: input.clientId } });
    const notice = createNotice(db, { eventSeq: event.seq, kind: "welcome", payload: { ...away }, ttlMs: WELCOME_TTL_MS, now });
    // The device that saw the user come back is the one that greets them.
    db.prepare("UPDATE core_notices SET state = 'claimed', claimed_by = ?, claim_until = ?, updated_at = ? WHERE id = ?")
      .run(input.clientId, iso(now + CLAIM_MS), iso(now), notice.id);
    return { returned: true, notice: { ...notice, state: "claimed", claimedBy: input.clientId, claimUntil: iso(now + CLAIM_MS) } };
  });
}
