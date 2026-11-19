import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addProject, CORE_MIGRATIONS, createRunDrain, getConversation, getRun, listEvents, listProjects, openWorld, ProjectError,
  removeProject, startSession, submitRun, trustProject,
  type EngineRequest, type EnginePort, type RunProfile, type World,
} from "../src/index.ts";

const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);
const folder = () => mkdtempSync(join(tmpdir(), "alfred-project-"));
const PROFILES: Record<string, RunProfile> = {
  assistant: { instructions: "", tools: [] },
  developer: { instructions: "", tools: [], workspace: true },
};

test("a project is a real folder, added once, untrusted until the user says so", () => {
  const w = world();
  const dir = folder();
  mkdirSync(join(dir, "app"));
  symlinkSync(join(dir, "app"), join(dir, "link"));
  const added = addProject(w, { path: join(dir, "link") });
  assert.equal(added.path, realpathSync(join(dir, "app")), "symlinks are resolved");
  assert.equal(added.name, "app");
  assert.equal(added.trustedAt, null);
  assert.equal(addProject(w, { path: join(dir, "app") }).id, added.id, "the same folder twice is one project");
  assert.throws(() => addProject(w, { path: "relative/path" }), ProjectError);
  assert.throws(() => addProject(w, { path: join(dir, "missing") }), /does not exist/);

  assert.throws(() => startSession(w, { projectId: added.id, title: "How is it built?" }), (error: ProjectError) => error.code === "untrusted");
  assert.ok(trustProject(w, added.id).trustedAt);
  const session = startSession(w, { projectId: added.id, title: "How is it built?" });
  assert.equal(session.projectId, added.id);
  assert.equal(session.title, "How is it built?");
  assert.deepEqual(listEvents(w).events.map((event) => event.kind).filter((kind) => kind.startsWith("project.")), ["project.added", "project.trusted"]);

  removeProject(w, added.id);
  assert.equal(listProjects(w).length, 0);
  assert.equal(getConversation(w, session.id).projectId, added.id, "its sessions stay");
});

test("a session's runs get the project's folder; a wrong profile or a removed project fails the run", async () => {
  const w = world();
  const project = trustProject(w, addProject(w, { path: folder(), name: "Shop" }).id);
  const session = startSession(w, { projectId: project.id, title: "Where is checkout?" });
  const seen: EngineRequest[] = [];
  const engine: EnginePort = { async submit(request) { seen.push(request); return { reply: "In src/checkout.ts" }; } };
  const drain = createRunDrain(w, engine, { owner: "test-owner", profiles: PROFILES });

  const ok = submitRun(w, { requestId: "r1", goal: "Where is checkout?", profile: "developer", conversationId: session.id }).run;
  await drain.kick();
  assert.equal(getRun(w, ok.id).run.state, "completed");
  assert.deepEqual(seen[0].workspace, { root: project.path, name: "Shop", mode: "ask" });

  // The everyday profile in a session, or a session profile outside one, never reaches the engine.
  const wrong = submitRun(w, { requestId: "r2", goal: "Hi", profile: "assistant", conversationId: session.id }).run;
  const daily = submitRun(w, { requestId: "r3", goal: "Hi", profile: "developer" }).run;
  await drain.kick();
  assert.equal(getRun(w, wrong.id).run.outcome?.error, "wrong_profile");
  assert.equal(getRun(w, daily.id).run.outcome?.error, "wrong_profile");

  removeProject(w, project.id);
  const gone = submitRun(w, { requestId: "r4", goal: "And now?", profile: "developer", conversationId: session.id }).run;
  await drain.kick();
  assert.equal(getRun(w, gone.id).run.outcome?.error, "project_unavailable");
  assert.equal(seen.length, 1);
});
