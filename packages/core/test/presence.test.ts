import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CORE_MIGRATIONS, finishRun, claimNextRun, listEvents, listNotices, openWorld, recordDomainEvent, reportPresence, submitRun,
  withCoreContext, type World,
} from "../src/index.ts";

const MIN = 60_000;
const T0 = new Date(2026, 10, 17, 9, 0).getTime();

function world(): World {
  return openWorld(":memory:", [...CORE_MIGRATIONS, { id: "toy:1", sql: "CREATE TABLE toys (id TEXT PRIMARY KEY) STRICT;" }]);
}
const welcomes = (w: World) => w.db.prepare("SELECT state, claimed_by FROM core_notices WHERE kind = 'welcome'").all();

test("the first report only starts the clock", () => {
  const w = world();
  assert.deepEqual(reportPresence(w, { clientId: "mac", kind: "active", now: T0 }), { returned: false, notice: null });
  assert.equal(welcomes(w).length, 0);
});

test("locking the screen and coming back greets once, on the device that saw it", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  const back = reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 25 * MIN });
  assert.equal(back.returned, true);
  assert.equal(back.notice?.claimedBy, "mac");
  assert.equal((back.notice?.payload.awayMs as number), 24 * MIN);
  // A heartbeat, a second window or another device a moment later: nobody is greeted again.
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 25 * MIN + 500 }).returned, false);
  assert.equal(reportPresence(w, { clientId: "phone", kind: "active", now: T0 + 26 * MIN }).returned, false);
  assert.equal(welcomes(w).length, 1);
});

test("a short break is not a return; a repeated away is recorded once", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + 2 * MIN });
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 6 * MIN }).returned, false);
  assert.equal(listEvents(w).events.filter((event) => event.kind === "presence.away").length, 1);
  assert.equal(welcomes(w).length, 0);
});

test("long silence without a lock is a return too, and so is a new day", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 20 * MIN }).returned, false);
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 51 * MIN }).returned, true);
  const lateNight = new Date(2026, 10, 17, 23, 50).getTime();
  const nextMorning = new Date(2026, 10, 18, 0, 5).getTime();
  reportPresence(w, { clientId: "mac", kind: "active", now: lateNight });
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: nextMorning }).returned, true);
});

test("heartbeats are written at most every few minutes", () => {
  const w = world();
  for (let minute = 0; minute < 10; minute++) reportPresence(w, { clientId: "mac", kind: "active", now: T0 + minute * MIN });
  assert.equal(listEvents(w).events.filter((event) => event.kind === "presence.active").length, 4);
});

test("the welcome says what Alfred did while the user was away, not what the user did", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  // While away: a run adds a toy; the user's own phone edit is not news.
  const { run } = submitRun(w, { requestId: "r1", goal: "add a kite", profile: "tasks", now: T0 + 2 * MIN });
  claimNextRun(w, "home", { now: T0 + 2 * MIN });
  withCoreContext({ actor: "alfred", run: { id: run.id, owner: "home" } }, () => w.tx(() =>
    recordDomainEvent(w, { kind: "toy.added", subject: "toy:kite", payload: {}, now: T0 + 2.5 * MIN })));
  finishRun(w, run.id, "home", { status: "completed", reply: "done" }, { now: T0 + 2.5 * MIN });
  withCoreContext({ actor: "user" }, () => w.tx(() => recordDomainEvent(w, { kind: "toy.added", subject: "toy:ball", payload: {}, now: T0 + 4 * MIN })));

  const back = reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 40 * MIN });
  const digest = back.notice!.payload as { runs: { completed: number; goals: string[] }; changes: Record<string, number>; waiting: number };
  assert.equal(digest.runs.completed, 1);
  assert.deepEqual(digest.runs.goals, ["add a kite"]);
  assert.deepEqual(digest.changes, { toy: 1 });
  assert.equal(digest.waiting, 1, "the run's result notice still waits");
});

test("a newer return replaces a welcome nobody saw", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 30 * MIN });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + 31 * MIN });
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 60 * MIN });
  assert.deepEqual(welcomes(w).map((row) => row.state).sort(), ["claimed", "expired"]);
  assert.equal(listNotices(w, { now: T0 + 60 * MIN }).filter((notice) => notice.kind === "welcome").length, 1);
});
