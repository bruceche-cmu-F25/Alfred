import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerRequest, CORE_MIGRATIONS, createRunDrain, getConversation, getRun, listConversations, listEvents, listNotices,
  openWorld, recordDomainEvent, requestCancel, RunError, submitRun, updateConversation,
  type EnginePort, type RunProfile, type RunTool, type World,
} from "../src/index.ts";

const TOY = { id: "toy:1", sql: "CREATE TABLE toys (id TEXT PRIMARY KEY NOT NULL) STRICT;" };
const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, TOY]);
const toys = (w: World) => w.db.prepare("SELECT id FROM toys ORDER BY id").all().map((row) => row.id);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function addToy(w: World): RunTool {
  return {
    name: "toy_add", label: "Add toy", description: "", parameters: { type: "object" },
    describe: (params) => String(params.name),
    execute: (params) => { w.tx(() => { w.db.prepare("INSERT INTO toys (id) VALUES (?)").run(String(params.name)); recordDomainEvent(w, { kind: "toy.added", payload: {} }); }); return "ok"; },
  };
}
function dropToy(w: World): RunTool {
  return {
    name: "toy_drop", label: "Drop toy", description: "", parameters: { type: "object" },
    permission: (params) => `Throw away ${String(params.name)} for good`,
    execute: (params) => { w.tx(() => { w.db.prepare("DELETE FROM toys WHERE id = ?").run(String(params.name)); recordDomainEvent(w, { kind: "toy.dropped", payload: {} }); }); return "dropped"; },
  };
}
function askUser(): RunTool {
  return {
    name: "ask_user", label: "Ask", description: "", parameters: { type: "object" },
    execute: (params, _signal, context) => context!.ask({ question: String(params.question), options: params.options as string[] }),
  };
}
const profiles = (w: World): Record<string, RunProfile> => ({ tasks: { instructions: "", tools: [addToy(w), dropToy(w), askUser()] } });
const tool = (request: Parameters<EnginePort["submit"]>[0], name: string) => request.tools.find((candidate) => candidate.name === name)!;

test("a first message starts a conversation named after it; later ones continue it", () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "Plan   the trip to\nLisbon in March with the kids", profile: "tasks" });
  const conversation = getConversation(w, run.conversationId);
  assert.equal(conversation.title, "Plan the trip to Lisbon in March with t…");
  const next = submitRun(w, { requestId: "r2", goal: "and book a hotel", profile: "tasks", conversationId: conversation.id }).run;
  assert.equal(next.conversationId, conversation.id);
  assert.equal(getConversation(w, conversation.id).busy, 2);
  assert.throws(() => submitRun(w, { requestId: "r3", goal: "x", profile: "tasks", conversationId: "nope" }), /No such conversation/);
});

test("conversations can be renamed and archived, and say what needs the user", () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "first", profile: "tasks" });
  updateConversation(w, run.conversationId, { title: "  Taxes 2026 " });
  updateConversation(w, run.conversationId, { archived: true });
  assert.equal(listConversations(w).length, 0);
  const [archived] = listConversations(w, { includeArchived: true });
  assert.equal(archived.title, "Taxes 2026");
  assert.ok(archived.archivedAt);
  assert.deepEqual(listEvents(w).events.map((event) => event.kind).filter((kind) => kind.startsWith("conversation.")),
    ["conversation.created", "conversation.renamed", "conversation.archived"]);
});

test("different conversations run side by side; one conversation runs in order", async () => {
  const w = world();
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const engine: EnginePort = { submit: (request) => new Promise((resolve) => { started.push(request.goal); release.set(request.goal, () => resolve({ reply: "ok" })); }) };
  const a1 = submitRun(w, { requestId: "a1", goal: "a1", profile: "tasks" }).run;
  submitRun(w, { requestId: "a2", goal: "a2", profile: "tasks", conversationId: a1.conversationId });
  submitRun(w, { requestId: "b1", goal: "b1", profile: "tasks" });
  const done = createRunDrain(w, engine, { owner: "home", profiles: profiles(w) }).kick();
  await tick();
  assert.deepEqual(started.sort(), ["a1", "b1"], "a2 waits for a1 in its conversation");
  release.get("a1")!();
  await tick();
  assert.ok(started.includes("a2"));
  release.get("a2")!(); release.get("b1")!();
  await done;
});

test("each tool call is a step, with what it was about", async () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "add a kite", profile: "tasks" });
  await createRunDrain(w, { submit: async (request) => { await tool(request, "toy_add").execute({ name: "kite" }, new AbortController().signal); return { reply: "ok" }; } },
    { owner: "home", profiles: profiles(w) }).kick();
  const steps = getRun(w, run.id).events.filter((event) => event.kind === "run.step").map((event) => [event.payload.tool, event.payload.about, event.payload.status]);
  assert.deepEqual(steps, [["toy_add", "kite", "started"], ["toy_add", "kite", "done"]]);
  assert.equal(getRun(w, run.id).run.outcome?.receipts.length, 1, "steps are not receipts");
});

test("a run can stop to ask, and continues with the user's answer", async () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  const engine: EnginePort = {
    async submit(request) {
      const answer = await tool(request, "ask_user").execute({ question: "Which one?", options: ["kite", "ball"] }, new AbortController().signal);
      await tool(request, "toy_add").execute({ name: answer }, new AbortController().signal);
      return { reply: `Added ${answer}` };
    },
  };
  const done = createRunDrain(w, engine, { owner: "home", profiles: profiles(w) }).kick();
  await tick();
  const waiting = getRun(w, run.id).run;
  assert.equal(waiting.state, "waiting_input");
  assert.deepEqual(waiting.request?.options, ["kite", "ball"]);
  const notice = listNotices(w).find((candidate) => candidate.kind === "run_request")!;
  assert.equal(notice.payload.question, "Which one?");
  assert.throws(() => answerRequest(w, run.id, { requestId: "stale", answer: "kite" }), RunError);
  answerRequest(w, run.id, { requestId: waiting.request!.id, answer: "ball" });
  await done;
  assert.equal(getRun(w, run.id).run.state, "completed");
  assert.deepEqual(toys(w), ["ball"]);
  assert.equal(listNotices(w).some((candidate) => candidate.kind === "run_request"), false, "the question is closed once answered");
  const answered = listEvents(w).events.find((event) => event.kind === "run.answered")!;
  assert.equal(answered.actor, "user");
});

test("an irreversible tool runs only after the user allows that one call", async () => {
  const w = world();
  w.db.prepare("INSERT INTO toys (id) VALUES ('kite'), ('ball')").run();
  const engine: EnginePort = {
    async submit(request) {
      const first = await tool(request, "toy_drop").execute({ name: "kite" }, new AbortController().signal);
      const second = await tool(request, "toy_drop").execute({ name: "ball" }, new AbortController().signal);
      return { reply: `${first} / ${second}` };
    },
  };
  const { run } = submitRun(w, { requestId: "r1", goal: "throw both away", profile: "tasks" });
  const done = createRunDrain(w, engine, { owner: "home", profiles: profiles(w) }).kick();
  await tick();
  let current = getRun(w, run.id).run;
  assert.equal(current.state, "waiting_permission");
  assert.equal(current.request?.question, "Throw away kite for good");
  assert.deepEqual(current.request?.options, ["allow", "deny"]);
  assert.throws(() => answerRequest(w, run.id, { requestId: current.request!.id, answer: "sure" }), /allow or deny/);
  answerRequest(w, run.id, { requestId: current.request!.id, answer: "allow" });
  await tick();
  current = getRun(w, run.id).run;
  assert.equal(current.request?.question, "Throw away ball for good", "the next call asks again");
  answerRequest(w, run.id, { requestId: current.request!.id, answer: "deny" });
  await done;
  assert.deepEqual(toys(w), ["ball"]);
  assert.match(getRun(w, run.id).run.outcome!.reply!, /dropped \/ The user did not allow this/);
});

test("cancelling a run that waits on the user stops it without an answer", async () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "ask me", profile: "tasks" });
  const done = createRunDrain(w, { submit: async (request) => ({ reply: await tool(request, "ask_user").execute({ question: "?" }, new AbortController().signal) }) },
    { owner: "home", profiles: profiles(w), heartbeatMs: 5 }).kick();
  await tick();
  assert.equal(getRun(w, run.id).run.state, "waiting_input");
  requestCancel(w, run.id);
  await done;
  const final = getRun(w, run.id).run;
  assert.equal(final.state, "cancelled");
  assert.equal(final.request, null);
});
