import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acknowledgeNotice, claimNotice, CommandConflictError, CORE_MIGRATIONS, createNotice, createRunDrain, executeNextRun, getRun,
  interruptOrphanedRuns, listEvents, listNotices, NoticeStateError, openWorld, presentNotice, recordDomainEvent,
  requestCancel, resumeRun, runCommand, RunError, RunLeaseLostError, submitRun, withCoreContext,
  type EnginePort, type RunProfile, type World,
} from "../src/index.ts";

const TOY = { id: "toy:1", sql: "CREATE TABLE toys (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) STRICT;" };

function world(): World {
  return openWorld(":memory:", [...CORE_MIGRATIONS, TOY]);
}

function addToy(w: World, name: string): void {
  w.tx((db) => {
    db.prepare("INSERT INTO toys (id, name) VALUES (?, ?)").run(name, name);
    recordDomainEvent(w, { kind: "toy.added", subject: `toy:${name}`, payload: { name } });
  });
}

function profiles(w: World): Record<string, RunProfile> {
  return {
    tasks: {
      instructions: "test",
      tools: [{
        name: "toy_add", label: "Add toy", description: "", parameters: { type: "object" },
        execute: (params) => { addToy(w, String(params.name)); return "ok"; },
      }],
    },
  };
}

const toys = (w: World) => w.db.prepare("SELECT name FROM toys ORDER BY name").all().map((row) => row.name);

test("a request id replays its run and refuses different content", () => {
  const w = world();
  const first = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  assert.equal(first.replayed, false);
  assert.equal(first.run.state, "queued");
  const again = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  assert.equal(again.replayed, true);
  assert.equal(again.run.id, first.run.id);
  assert.throws(() => submitRun(w, { requestId: "r1", goal: "something else", profile: "tasks" }), RunError);
});

test("a run's receipts are the domain events written under it, and it leaves one notice", async () => {
  const w = world();
  const engine: EnginePort = {
    async submit(request) {
      await request.tools[0].execute({ name: "kite" }, new AbortController().signal);
      return { reply: "Added a kite." };
    },
  };
  const { run } = submitRun(w, { requestId: "r1", goal: "add a kite", profile: "tasks" });
  await createRunDrain(w, engine, { owner: "node-a", profiles: profiles(w) }).kick();
  const { run: done, events } = getRun(w, run.id);
  assert.equal(done.state, "completed");
  const receipt = events.find((event) => event.kind === "toy.added");
  assert.ok(receipt);
  assert.equal(receipt.actor, "alfred");
  assert.deepEqual(done.outcome?.receipts, [receipt.id]);
  assert.deepEqual(toys(w), ["kite"]);
  const notices = listNotices(w);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "run_result");
  assert.equal(notices[0].payload.reply, "Added a kite.");
});

test("a reply that claims work without a tool call has no receipts", async () => {
  const w = world();
  const engine: EnginePort = { submit: async () => ({ reply: "Done, I added it!" }) };
  const { run } = submitRun(w, { requestId: "r1", goal: "add a kite", profile: "tasks" });
  await executeNextRun(w, engine, { owner: "node-a", profiles: profiles(w) });
  assert.deepEqual(getRun(w, run.id).run.outcome?.receipts, []);
});

test("a write under a lapsed lease is refused and rolled back", async () => {
  const w = world();
  let now = Date.now();
  const engine: EnginePort = {
    async submit(request) {
      // The lease runs out while the model is thinking.
      w.db.prepare("UPDATE core_runs SET lease_until = ?").run(new Date(now - 1).toISOString());
      return { reply: String(await request.tools[0].execute({ name: "late" }, new AbortController().signal)) };
    },
  };
  submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  const run = await executeNextRun(w, engine, { owner: "node-a", profiles: profiles(w) });
  assert.deepEqual(toys(w), []);
  assert.equal(run?.state, "interrupted");
  assert.throws(() => withCoreContext({ actor: "alfred", run: { id: run!.id, owner: "node-a" } }, () => addToy(w, "x")), RunLeaseLostError);
});

test("a restart interrupts the dead executor's run; it is never re-run until resumed", async () => {
  const w = world();
  let calls = 0;
  const hang: EnginePort = { submit: () => { calls++; return new Promise(() => {}); } };
  const { run } = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  void executeNextRun(w, hang, { owner: "node-old", profiles: profiles(w), heartbeatMs: 1e9 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getRun(w, run.id).run.state, "running");

  // The home node restarts under a new owner.
  assert.equal(interruptOrphanedRuns(w, "node-new"), 1);
  assert.equal(getRun(w, run.id).run.state, "interrupted");
  assert.ok(listNotices(w).some((notice) => notice.kind === "run_interrupted"));
  const ok: EnginePort = { submit: async () => { calls++; return { reply: "ok" }; } };
  await createRunDrain(w, ok, { owner: "node-new", profiles: profiles(w) }).kick();
  assert.equal(calls, 1, "the drain must not pick an interrupted run up again");

  resumeRun(w, run.id);
  await createRunDrain(w, ok, { owner: "node-new", profiles: profiles(w) }).kick();
  const resumed = getRun(w, run.id).run;
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.attempt, 2);
});

test("cancelling a running run waits for the engine's real result", async () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  const engine: EnginePort = {
    submit: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const pending = executeNextRun(w, engine, { owner: "node-a", profiles: profiles(w), heartbeatMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requestCancel(w, run.id).state, "cancelling");
  assert.equal((await pending)?.state, "cancelled");

  const queued = submitRun(w, { requestId: "r2", goal: "another", profile: "tasks" }).run;
  assert.equal(requestCancel(w, queued.id).state, "cancelled");
});

test("an unknown profile fails without calling the engine", async () => {
  const w = world();
  let called = false;
  submitRun(w, { requestId: "r1", goal: "x", profile: "nope" });
  const run = await executeNextRun(w, { submit: async () => { called = true; return { reply: "" }; } }, { owner: "a", profiles: profiles(w) });
  assert.equal(run?.state, "failed");
  assert.equal(run?.outcome?.error, "unknown_profile");
  assert.equal(called, false);
});

test("only the claiming device presents a notice, and never twice", async () => {
  const w = world();
  submitRun(w, { requestId: "r1", goal: "x", profile: "tasks" });
  await executeNextRun(w, { submit: async () => ({ reply: "done" }) }, { owner: "a", profiles: profiles(w) });
  const [notice] = listNotices(w);
  claimNotice(w, notice.id, "mac");
  assert.throws(() => claimNotice(w, notice.id, "phone"), NoticeStateError);
  assert.throws(() => presentNotice(w, notice.id, "phone"), NoticeStateError);
  assert.equal(presentNotice(w, notice.id, "mac").state, "presented");
  assert.throws(() => claimNotice(w, notice.id, "phone"), NoticeStateError);
  assert.equal(acknowledgeNotice(w, notice.id).state, "acknowledged");
  assert.deepEqual(listNotices(w), []);
});

test("dismissing a notice is an event, so every device hears of it and drops it; once", () => {
  const w = world();
  const notice = w.tx((db) => {
    const event = recordDomainEvent(w, { kind: "toy.added", payload: {} });
    return createNotice(db, { eventSeq: event.seq, kind: "welcome", payload: {} });
  });
  claimNotice(w, notice.id, "mac");
  presentNotice(w, notice.id, "mac");
  const before = listEvents(w).cursor;
  assert.equal(acknowledgeNotice(w, notice.id).state, "acknowledged");
  acknowledgeNotice(w, notice.id);
  assert.deepEqual(listEvents(w, { after: before }).events.map((event) => [event.kind, event.subject, event.actor, event.payload.kind]),
    [["notice.acknowledged", `notice:${notice.id}`, "user", "welcome"]]);
  assert.equal(listNotices(w, { states: ["pending", "claimed", "presented"] }).length, 0);
});

test("notices nobody dismissed do not keep a new one from being listed", () => {
  const w = world();
  const tell = (now: number) => w.tx((db) => {
    const event = recordDomainEvent(w, { kind: "toy.added", payload: {}, now });
    return createNotice(db, { eventSeq: event.seq, kind: "run_result", payload: {}, now });
  });
  const start = Date.now() - 60_000;
  const old = Array.from({ length: 60 }, (_, i) => tell(start + i));
  // Shown once, never clicked: they stay in the inbox.
  for (const notice of old) { claimNotice(w, notice.id, "mac"); presentNotice(w, notice.id, "mac"); }
  const fresh = tell(Date.now());
  const listed = listNotices(w, { states: ["pending", "claimed", "presented"] });
  assert.equal(listed.length, 50);
  assert.equal(listed.at(-1)!.id, fresh.id, "the newest is there, last");
  assert.equal(listed[0].id, old[11].id, "the oldest are the ones left out");
});

test("a command runs once per request id and rolls back with its change", () => {
  const w = world();
  const add = (name: string, requestId: string) => runCommand(w, { requestId, command: "toy.add", input: { name } }, () => { addToy(w, name); return { name }; });
  assert.deepEqual(add("kite", "c1"), { result: { name: "kite" }, replayed: false });
  assert.deepEqual(add("kite", "c1"), { result: { name: "kite" }, replayed: true });
  assert.deepEqual(toys(w), ["kite"]);
  assert.throws(() => add("ball", "c1"), CommandConflictError);
  assert.throws(() => runCommand(w, { requestId: "c2", command: "toy.add", input: {} }, () => { addToy(w, "boom"); throw new Error("no"); }));
  assert.deepEqual(toys(w), ["kite"]);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM core_commands").get()!.n, 1);
});

test("transactions are synchronous, nest as savepoints and signal commits", () => {
  const w = world();
  let commits = 0;
  w.onCommit(() => commits++);
  w.tx(() => {
    addToy(w, "a");
    assert.throws(() => w.tx(() => { addToy(w, "b"); throw new Error("inner"); }));
  });
  assert.deepEqual(toys(w), ["a"]);
  assert.equal(commits, 1);
  assert.throws(() => w.tx(async () => {}), /synchronous/);
  assert.throws(() => recordDomainEvent(w, { kind: "toy.added", payload: {} }), /inside the domain's own transaction/);
  assert.equal(listEvents(w).events.length, 1);
});
