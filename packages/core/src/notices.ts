/** Nothing is spoken or shown directly: results, interruptions and requests
 * become notices, and only a device's report that it actually presented one
 * marks it delivered. A notice is information, never an instruction.
 */
import type { DatabaseSync } from "node:sqlite";
import { iso, newId } from "./ids.ts";
import { NOTICE_STATES } from "./schema.ts";
import type { World } from "./world.ts";

export type NoticeState = (typeof NOTICE_STATES)[number];
export interface Notice {
  id: string;
  eventSeq: number;
  kind: string;
  state: NoticeState;
  createdAt: string;
  updatedAt: string;
  claimedBy: string | null;
  claimUntil: string | null;
  expiresAt: string | null;
  payload: Record<string, unknown>;
}

export class NoticeStateError extends Error {
  override name = "NoticeStateError";
  readonly code: "missing" | "state" | "claim";
  constructor(code: "missing" | "state" | "claim") {
    super(code === "missing" ? "No such notice" : code === "claim" ? "Notice is claimed by another device" : "Notice is not in a state that allows this");
    this.code = code;
  }
}

const CLIENT = /^[A-Za-z0-9._:-]{1,80}$/;
function client(value: string): string {
  if (!CLIENT.test(value)) throw new Error("Invalid client id");
  return value;
}

function toNotice(row: Record<string, unknown>): Notice {
  return {
    id: row.id as string, eventSeq: row.event_seq as number, kind: row.kind as string, state: row.state as NoticeState,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string, claimedBy: row.claimed_by as string | null,
    claimUntil: row.claim_until as string | null, expiresAt: row.expires_at as string | null, payload: JSON.parse(row.payload as string),
  };
}

/** Only inside a world transaction, next to the event it is about. */
export function createNotice(db: DatabaseSync, input: { eventSeq: number; kind: string; payload: Record<string, unknown>; ttlMs?: number; now?: number }): Notice {
  const now = input.now ?? Date.now();
  const id = newId();
  db.prepare(`INSERT INTO core_notices (id, event_seq, kind, state, created_at, updated_at, expires_at, payload)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, input.eventSeq, input.kind, iso(now), iso(now), input.ttlMs ? iso(now + input.ttlMs) : null, JSON.stringify(input.payload));
  return load(db, id);
}

function load(db: DatabaseSync, id: string): Notice {
  const row = db.prepare("SELECT * FROM core_notices WHERE id = ?").get(id);
  if (!row) throw new NoticeStateError("missing");
  return toNotice(row);
}

function expire(db: DatabaseSync, now: number): void {
  db.prepare(`UPDATE core_notices SET state = 'expired', updated_at = ?, claimed_by = NULL, claim_until = NULL
    WHERE state IN ('pending', 'claimed') AND expires_at IS NOT NULL AND expires_at <= ?`).run(iso(now), iso(now));
}

/** Undelivered notices, oldest first. A lapsed claim counts as pending again. */
export function listNotices(world: World, options: { states?: NoticeState[]; limit?: number; now?: number } = {}): Notice[] {
  const now = options.now ?? Date.now();
  const states = options.states ?? ["pending", "claimed"];
  for (const state of states) if (!NOTICE_STATES.includes(state)) throw new Error("Unknown notice state");
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  return world.tx((db) => {
    expire(db, now);
    return db.prepare(`SELECT * FROM core_notices WHERE state IN (SELECT value FROM json_each(?))
      ORDER BY created_at, rowid LIMIT ?`).all(JSON.stringify(states), limit).map(toNotice);
  });
}

/** One device at a time may present a notice; the claim lapses after ttlMs. */
export function claimNotice(world: World, id: string, clientId: string, options: { ttlMs?: number; now?: number } = {}): Notice {
  const now = options.now ?? Date.now();
  const by = client(clientId);
  return world.tx((db) => {
    expire(db, now);
    const notice = load(db, id);
    const reclaimable = notice.state === "claimed" && (notice.claimedBy === by || Date.parse(notice.claimUntil!) <= now);
    if (notice.state !== "pending" && !reclaimable) throw new NoticeStateError(notice.state === "claimed" ? "claim" : "state");
    db.prepare("UPDATE core_notices SET state = 'claimed', claimed_by = ?, claim_until = ?, updated_at = ? WHERE id = ?")
      .run(by, iso(now + (options.ttlMs ?? 30_000)), iso(now), id);
    return load(db, id);
  });
}

/** The device began playing or displaying it. Never replayed after this,
 * even if playback is then interrupted.
 */
export function presentNotice(world: World, id: string, clientId: string, options: { now?: number } = {}): Notice {
  const now = options.now ?? Date.now();
  const by = client(clientId);
  return world.tx((db) => {
    const notice = load(db, id);
    if (notice.state === "presented" || notice.state === "acknowledged") return notice;
    if (notice.state !== "claimed") throw new NoticeStateError("state");
    if (notice.claimedBy !== by) throw new NoticeStateError("claim");
    db.prepare("UPDATE core_notices SET state = 'presented', claim_until = NULL, updated_at = ? WHERE id = ?").run(iso(now), id);
    return load(db, id);
  });
}

/** The user dismissed or opened it. Allowed from any undelivered state. */
export function acknowledgeNotice(world: World, id: string, options: { now?: number } = {}): Notice {
  const now = options.now ?? Date.now();
  return world.tx((db) => {
    const notice = load(db, id);
    if (notice.state === "acknowledged") return notice;
    if (notice.state === "expired") throw new NoticeStateError("state");
    db.prepare("UPDATE core_notices SET state = 'acknowledged', claimed_by = NULL, claim_until = NULL, updated_at = ? WHERE id = ?").run(iso(now), id);
    return load(db, id);
  });
}
