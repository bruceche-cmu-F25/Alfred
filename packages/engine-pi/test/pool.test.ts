import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CORE_MIGRATIONS, createRunDrain, getRun, openWorld, recordDomainEvent, submitRun,
  type EngineRequest, type RunTool, type World,
} from "@alfred/core";
import { createWorkerEngine, type WorkerEngine } from "../src/index.ts";

const worker = fileURLToPath(new URL("./fixtures/fake-worker.ts", import.meta.url));
const engines: WorkerEngine[] = [];
const engine = (options: { idleMs?: number; abortGraceMs?: number } = {}) => {
  const created = createWorkerEngine({ worker, ...options });
  engines.push(created);
  return created;
};
test.after(() => engines.forEach((created) => created.close()));

function request(goal: string, tools: RunTool[] = [], extra: Partial<EngineRequest> = {}): EngineRequest {
  return { thread: "t1", goal, instructions: "", history: [], tools, today: "2026-11-18", timezone: "UTC", ...extra };
}

test("a tool call travels to the home node and its result goes back to the model; text streams", async () => {
  const seen: unknown[] = [];
  const texts: string[] = [];
  const echo: RunTool = { name: "echo", label: "Echo", description: "", parameters: { type: "object" }, execute: (params) => { seen.push(params); return `got ${String(params.word)}`; } };
  const result = await engine().submit({ ...request('tool echo {"word":"kite"}', [echo]), onText: (text) => texts.push(text) }, new AbortController().signal);
  assert.equal(result.reply, "tool said: got kite");
  assert.deepEqual(seen, [{ word: "kite" }]);
  assert.deepEqual(texts, ["thinking"]);
});

test("a tool that fails reports its error to the model instead of crashing the run", async () => {
  const broken: RunTool = { name: "broken", label: "", description: "", parameters: {}, execute: () => { throw new Error("disk full"); } };
  const result = await engine().submit(request("tool broken {}", [broken]), new AbortController().signal);
  assert.equal(result.reply, "tool said: error: disk full");
});

test("a crashed worker fails only its run; the next run gets a fresh worker", async () => {
  const pool = engine();
  await assert.rejects(pool.submit(request("crash"), new AbortController().signal), { name: "EngineCrashedError" });
  assert.equal((await pool.submit(request("hello"), new AbortController().signal)).reply, "echo: hello");
});

test("aborting stops the worker's run; a worker that ignores it is killed", async () => {
  const pool = engine({ abortGraceMs: 100 });
  const polite = new AbortController();
  const hanging = pool.submit(request("hang"), polite.signal);
  setTimeout(() => polite.abort(), 50);
  await assert.rejects(hanging, { name: "AbortError" });

  const stubborn = new AbortController();
  const ignoring = pool.submit(request("stubborn"), stubborn.signal);
  setTimeout(() => stubborn.abort(new Error("cancelled")), 50);
  await assert.rejects(ignoring, /cancelled/);
});

test("warm workers are reused, parallel runs get their own, idle ones stop", async () => {
  const pool = engine({ idleMs: 200 });
  const first = (await pool.submit(request("who"), new AbortController().signal)).reply;
  const second = (await pool.submit(request("who", [], { thread: "t2", history: [{ role: "user", text: "earlier" }] }), new AbortController().signal)).reply;
  assert.equal(first.split("pid=")[1], second.split("pid=")[1], "the same warm worker");
  assert.match(first, /^t1 history=no/);
  assert.match(second, /^t2 history=yes/);
  const both = await Promise.all([pool.submit(request("who"), new AbortController().signal), pool.submit(request("who"), new AbortController().signal)]);
  assert.notEqual(both[0].reply.split("pid=")[1], both[1].reply.split("pid=")[1], "two at once need two workers");
  assert.equal(pool.size(), 2);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(pool.size(), 0, "idle workers are stopped");
});

test("through the core: the model's tool writes under the run's lease; a crash keeps what was done and redoes nothing", async () => {
  const w: World = openWorld(":memory:", [...CORE_MIGRATIONS, { id: "toy:1", sql: "CREATE TABLE toys (id TEXT PRIMARY KEY NOT NULL) STRICT;" }]);
  const add: RunTool = {
    name: "toy_add", label: "Add toy", description: "", parameters: { type: "object" },
    execute: (params) => { w.tx(() => { w.db.prepare("INSERT INTO toys (id) VALUES (?)").run(String(params.name)); recordDomainEvent(w, { kind: "toy.added", payload: {} }); }); return "added"; },
  };
  const pool = engine();
  const drain = createRunDrain(w, pool, { owner: "home", profiles: { tasks: { instructions: "", tools: [add] } } });
  const ok = submitRun(w, { requestId: "r1", goal: 'tool toy_add {"name":"kite"}', profile: "tasks" }).run;
  const crash = submitRun(w, { requestId: "r2", goal: "crash", profile: "tasks" }).run;
  await drain.kick();
  const done = getRun(w, ok.id);
  assert.equal(done.run.state, "completed");
  assert.equal(done.run.outcome?.receipts.length, 1);
  assert.equal(done.events.filter((event) => event.kind === "run.step").length, 2, "steps are recorded in the home node");
  const crashed = getRun(w, crash.id).run;
  assert.equal(crashed.state, "failed");
  assert.equal(crashed.outcome?.error, "engine_crashed");
  w.close();
});
