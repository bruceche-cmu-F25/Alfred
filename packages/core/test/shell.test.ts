import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addProject, answerRequest, commandAllowed, CORE_MIGRATIONS, createRunDrain, getConversation, getRun, grantCommand, listCommandGrants, listEvents,
  openWorld, pairDevice, revokeCommand, revokeDevice, setDeviceScope, simpleCommand, startSession, submitRun, trustProject,
  type EnginePort, type EngineRequest, type RunProfile, type World,
} from "../src/index.ts";

const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);
const PROFILES: Record<string, RunProfile> = {
  assistant: { instructions: "", tools: [] },
  developer: { instructions: "", tools: [], workspace: true, modes: { plan: "", ask: "", edits: "" } },
};
function session(w: World) {
  const project = trustProject(w, addProject(w, { path: mkdtempSync(join(tmpdir(), "alfred-shell-")), name: "Shop" }).id);
  return startSession(w, { projectId: project.id, title: "Run the tests" });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("only a plain command can be allowed for a session, and a grant covers it with more arguments, nothing else", () => {
  for (const plain of ["npm test", "  git   status ", "node --test packages/core/test/shell.test.ts"]) assert.ok(simpleCommand(plain), plain);
  for (const not of ["", "npm test; rm -rf x", "npm test && rm -rf x", "cat a | sh", "echo $(whoami)", "echo `whoami`", "echo ${HOME}", "ls > out", "cat < in", "sleep 9 &", "a\nb"]) {
    assert.equal(simpleCommand(not), false, not);
  }
  const grants = ["npm test"];
  assert.ok(commandAllowed(grants, "npm test"));
  assert.ok(commandAllowed(grants, "npm  test -- shell"), "more arguments after it");
  assert.equal(commandAllowed(grants, "npm testx"), false, "not a longer word");
  assert.equal(commandAllowed(grants, "npm run build"), false);
  assert.equal(commandAllowed(grants, "npm test; rm -rf x"), false, "a chain always asks");
  assert.equal(commandAllowed(grants, "npm test | tee log"), false);
});

test("a command asks, shown whole; `always` allows it for the rest of that session, and is taken back by the user or with the device", async () => {
  const w = world();
  const s = session(w);
  const answers: string[] = [];
  const seen: EngineRequest[] = [];
  const engine: EnginePort = {
    async submit(request) {
      seen.push(request);
      answers.push(await request.external.allow("Run this command?", { command: "npm test" }));
      answers.push(await request.external.allow("Run this command?", { command: "npm test && rm -rf build" }));
      return { reply: "ran" };
    },
  };
  const drain = createRunDrain(w, engine, { owner: "test-owner", profiles: PROFILES });
  const phone = pairDevice(w, { token: "t".repeat(40), name: "Phone", kind: "phone" });
  assert.deepEqual(phone.scopes, [], "no device starts with dev");
  assert.deepEqual(setDeviceScope(w, phone.id, "dev", true).scopes, ["dev"]);

  const run = submitRun(w, { requestId: "r1", goal: "Run the tests", profile: "developer", conversationId: s.id }).run;
  const done = drain.kick();
  await tick();
  const first = getRun(w, run.id).run.request!;
  assert.equal(first.detail, "npm test");
  assert.equal(first.detailKind, "command");
  assert.equal(first.grant, "npm test");
  assert.deepEqual(first.options, ["allow", "deny", "always"]);
  answerRequest(w, run.id, { requestId: first.id, answer: "always", by: phone.id });
  await tick();
  // A chained command is never offered `always`.
  const second = getRun(w, run.id).run.request!;
  assert.equal(second.detail, "npm test && rm -rf build");
  assert.deepEqual(second.options, ["allow", "deny"]);
  assert.equal(second.grant, undefined);
  answerRequest(w, run.id, { requestId: second.id, answer: "deny" });
  await done;
  assert.deepEqual(answers, ["always", "deny"]);

  assert.deepEqual(listCommandGrants(w, s.id).map((grant) => [grant.command, grant.by]), [["npm test", phone.id]]);
  assert.deepEqual(getConversation(w, s.id).commands, ["npm test"]);
  // The command is not in the log's question: the event keeps the question, not what was asked about.
  const waiting = listEvents(w).events.filter((event) => event.kind === "run.waiting");
  assert.ok(waiting.every((event) => !JSON.stringify(event.payload).includes("npm test")));

  // The next run is told what is allowed.
  submitRun(w, { requestId: "r2", goal: "Again", profile: "developer", conversationId: s.id });
  const again = drain.kick();
  await tick();
  assert.deepEqual(seen[1].workspace?.commands, ["npm test"]);
  const pending = getRun(w, listEvents(w).events.findLast((event) => event.kind === "run.waiting")!.runId!).run;
  answerRequest(w, pending.id, { requestId: pending.request!.id, answer: "deny" });
  await tick();
  const last = getRun(w, pending.id).run;
  answerRequest(w, last.id, { requestId: last.request!.id, answer: "deny" });
  await again;

  // The user takes one back; turning the device's scope off (or revoking it) ends what it allowed.
  grantCommand(w, s.id, "git status", "home");
  assert.deepEqual(revokeCommand(w, s.id, "git status").map((grant) => grant.command), ["npm test"]);
  setDeviceScope(w, phone.id, "dev", false);
  assert.deepEqual(getConversation(w, s.id).commands, []);
  grantCommand(w, s.id, "npm test", phone.id);
  revokeDevice(w, phone.id);
  assert.deepEqual(getConversation(w, s.id).commands, []);
  assert.throws(() => grantCommand(w, s.id, "a; b", "home"), /plain command/);
});

test("an everyday conversation runs no commands", async () => {
  const w = world();
  let answer = "";
  const engine: EnginePort = { async submit(request) { answer = await request.external.allow("Run?", { command: "ls" }); return { reply: "" }; } };
  const drain = createRunDrain(w, engine, { owner: "test-owner", profiles: PROFILES });
  submitRun(w, { requestId: "r1", goal: "ls", profile: "assistant" });
  await drain.kick();
  assert.equal(answer, "deny");
});
