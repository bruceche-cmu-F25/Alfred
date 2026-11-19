import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claimOutbound, enqueueOutbound, finishOutbound, listOutbound, withCoreContext, type EnginePort } from "@alfred/core";
import { defineModule } from "@alfred/module-kit";
import { todoModule, type TodoSnapshot } from "@alfred/module-todo";
import type { ConversationDetail, CoreEvent, RunDetail, SessionChanges, StateResponse, SubmitRunResponse } from "@alfred/protocol";
import { AUTOMATION_PROFILE, ASSISTANT_PROFILE, createHttpServer, openHome, profiles, type Home } from "../src/index.ts";

/** Adds the todo named in the goal through the run's own tool. */
const engine: EnginePort = {
  async submit(request) {
    const title = request.goal.replace(/^add /, "");
    const text = await request.tools.find((tool) => tool.name === "todo_add")!.execute({ title, due: "2026-11-20" }, new AbortController().signal);
    return { reply: `OK. ${text.split("\n")[0]}` };
  },
};

async function start(home: Home): Promise<{ server: Server; base: string }> {
  const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Reads SSE until `until` matches an event. */
async function waitForEvent(base: string, after: number, until: (event: CoreEvent) => boolean): Promise<CoreEvent[]> {
  const response = await fetch(`${base}/api/events?after=${after}`);
  const reader = response.body!.getReader();
  const seen: CoreEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return seen;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)) as CoreEvent;
      seen.push(event);
      if (until(event)) { await reader.cancel(); return seen; }
    }
  }
}

test("a sentence becomes a run, a todo, a receipt and a notice, streamed to devices", async () => {
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const before = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    const submitted = await post(base, "/api/runs", { requestId: "r-1", goal: "add Hand in report" });
    assert.equal(submitted.status, 202);
    const { run } = (await submitted.json()) as SubmitRunResponse;

    const events = await waitForEvent(base, before.cursor, (event) => event.kind === "run.completed");
    // A new conversation, the run, and one step around the tool call that wrote the todo.
    assert.deepEqual(events.map((event) => event.kind), ["conversation.created", "run.queued", "run.started", "run.step", "todo.added", "run.step", "run.completed"]);
    assert.deepEqual(events.filter((event) => event.kind === "run.step").map((event) => event.payload.status), ["started", "done"]);
    assert.deepEqual(events.map((event) => event.seq), [...events.map((event) => event.seq)].sort((a, b) => a - b));

    const detail = (await (await fetch(`${base}/api/runs/${run.id}`)).json()) as RunDetail;
    const added = events.find((event) => event.kind === "todo.added")!;
    assert.deepEqual(detail.run.outcome?.receipts, [added.id]);
    assert.equal(added.actor, "alfred");

    const after = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    const todos = (after.modules.todo as TodoSnapshot).todos;
    assert.deepEqual(todos.map((todo) => [todo.title, todo.due]), [["Hand in report", "2026-11-20"]]);
    const [notice] = after.notices;
    assert.equal(notice.payload.runId, run.id);

    // Retrying the same submit returns the same run, and nothing runs twice.
    const replay = await post(base, "/api/runs", { requestId: "r-1", goal: "add Hand in report" });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as SubmitRunResponse).run.id, run.id);
    assert.equal((await post(base, "/api/runs", { requestId: "r-1", goal: "something else" })).status, 409);

    // One device presents the notice; another cannot.
    assert.equal((await post(base, `/api/notices/${notice.id}/claim`, { client: "mac" })).status, 200);
    assert.equal((await post(base, `/api/notices/${notice.id}/claim`, { client: "phone" })).status, 409);
    assert.equal((await post(base, `/api/notices/${notice.id}/present`, { client: "mac" })).status, 200);
  } finally {
    server.close(); server.closeAllConnections();
    home.close();
  }
});

test("device commands go through the same operations and replay safely", async () => {
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const add = await post(base, "/api/ops/todo.add", { requestId: "c-1", input: { title: "Buy milk" } });
    assert.equal(add.status, 200);
    const { result } = (await add.json()) as { result: { id: string } };
    assert.equal(((await (await post(base, "/api/ops/todo.add", { requestId: "c-1", input: { title: "Buy milk" } })).json()) as { replayed: boolean }).replayed, true);
    assert.equal((await post(base, "/api/ops/todo.add", { requestId: "c-2", input: { title: 5 } })).status, 400);
    assert.equal((await post(base, "/api/ops/todo.nope", { requestId: "c-3", input: {} })).status, 404);
    const stale = await post(base, "/api/ops/todo.update", { requestId: "c-4", input: { id: result.id, revision: "stale", patch: { title: "x" } } });
    assert.equal(stale.status, 409);
    const done = await post(base, "/api/ops/todo.complete", { requestId: "c-5", input: { id: result.id } });
    assert.equal(done.status, 200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    assert.equal((state.modules.todo as TodoSnapshot).todos[0].done, true);
  } finally {
    server.close(); server.closeAllConnections();
    home.close();
  }
});

test("only loopback hosts and same-origin browsers are served", async () => {
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule] });
  const { server, base } = await start(home);
  const port = (server.address() as AddressInfo).port;
  const status = (headers: Record<string, string>, method = "GET", path = "/api/state") => new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
  try {
    assert.equal(await status({ Host: `127.0.0.1:${port}` }), 200);
    assert.equal(await status({ Host: `evil.example:${port}` }), 403);
    assert.equal(await status({ Host: `127.0.0.1:${port}`, Origin: "https://evil.example", "Content-Type": "application/json" }, "POST", "/api/runs"), 403);
    assert.equal(await status({ Host: `127.0.0.1:${port}`, "Content-Type": "text/plain" }, "POST", "/api/runs"), 415);
    assert.equal((await fetch(`${base}/`)).status, 503);
  } finally {
    server.close(); server.closeAllConnections();
    home.close();
  }
});

test("killing the home node mid-run: on restart the run is interrupted, its write kept, nothing re-run", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-"));
  const fixture = fileURLToPath(new URL("./fixtures/hanging-home.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture, dataDir], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => { const match = /PORT (\d+)/.exec(chunk.toString()); if (match) resolve(Number(match[1])); });
    child.on("exit", () => reject(new Error("fixture exited")));
  });
  const base = `http://127.0.0.1:${port}`;
  const exited = new Promise((resolve) => child.on("exit", resolve));
  let run: SubmitRunResponse["run"];
  try {
    run = ((await (await post(base, "/api/runs", { requestId: "r-crash", goal: "add something" })).json()) as SubmitRunResponse).run;
    await waitForEvent(base, 0, (event) => event.kind === "todo.added");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }

  let calls = 0;
  const home = openHome({ dataDir, modules: [todoModule], engine: { submit: async () => { calls++; return { reply: "" }; } } });
  try {
    home.kick();
    await home.idle();
    const restarted = await start(home);
    const detail = (await (await fetch(`${restarted.base}/api/runs/${run.id}`)).json()) as RunDetail;
    assert.equal(detail.run.state, "interrupted");
    assert.equal(calls, 0, "an interrupted run is never re-run by itself");
    const state = (await (await fetch(`${restarted.base}/api/state`)).json()) as StateResponse;
    assert.deepEqual((state.modules.todo as TodoSnapshot).todos.map((todo) => todo.title), ["Written before the crash"]);
    assert.ok(state.notices.some((notice) => notice.kind === "run_interrupted" && notice.payload.runId === run.id));
    restarted.server.close(); restarted.server.closeAllConnections();
  } finally {
    home.close();
  }
});

test("a second home node on the same data directory is refused", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-"));
  const home = openHome({ dataDir, engine, modules: [todoModule] });
  try {
    assert.throws(() => openHome({ dataDir, engine, modules: [todoModule] }), /Another Alfred home node is running/);
  } finally {
    home.close();
  }
  openHome({ dataDir, engine, modules: [todoModule] }).close();
});

test("conversations over HTTP: a run asks, the device answers, the reply streams live", async () => {
  const asking: EnginePort = {
    async submit(request) {
      request.onText?.("Let me check…");
      const said = await request.tools.find((tool) => tool.name === "ask_user")!.execute({ question: "Which day?", options: ["Friday", "Monday"] }, new AbortController().signal);
      const answer = said.replace(/^The user answered: /, "");
      await request.tools.find((tool) => tool.name === "todo_add")!.execute({ title: `Report (${answer})` }, new AbortController().signal);
      request.onText?.(`Added for ${answer}.`);
      return { reply: `Added for ${answer}.` };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: asking, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const stream = await fetch(`${base}/api/events`);
    const reader = stream.body!.getReader();
    const { run } = (await (await post(base, "/api/runs", { requestId: "r-ask", goal: "add the report" })).json()) as SubmitRunResponse;
    // The run waits on a question; the conversation says it needs the user.
    const waiting = await (async () => {
      for (let i = 0; i < 100; i++) {
        const detail = (await (await fetch(`${base}/api/conversations/${run.conversationId}`)).json()) as ConversationDetail;
        if (detail.runs[0].request) return detail;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("never asked");
    })();
    assert.equal(waiting.conversation.attention, 1);
    assert.deepEqual(waiting.runs[0].request!.options, ["Friday", "Monday"]);
    const state = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    assert.equal(state.conversations[0].id, run.conversationId);
    assert.deepEqual(state.views, { todo: [{ id: "list", title: "Todos" }] });

    assert.equal((await post(base, `/api/runs/${run.id}/respond`, { requestId: "wrong", answer: "Friday" })).status, 409);
    assert.equal((await post(base, `/api/runs/${run.id}/respond`, { requestId: waiting.runs[0].request!.id, answer: "Monday" })).status, 200);

    // Live text arrives as `live` events; the record arrives as `core` events.
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: core\n") || !text.includes('"run.completed"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    assert.match(text, /event: live\ndata: \{"runId":"[^"]+","conversationId":"[^"]+","text":"Let me check…"\}/);
    const detail = (await (await fetch(`${base}/api/conversations/${run.conversationId}`)).json()) as ConversationDetail;
    assert.equal(detail.runs[0].outcome?.reply, "Added for Monday.");
    assert.deepEqual(detail.activity[run.id].map((event) => event.kind), ["run.step", "run.waiting", "run.answered", "run.step", "run.step", "run.step"]);
    assert.equal((await post(base, `/api/conversations/${run.conversationId}`, { title: "Reports" })).status, 200);
    assert.equal((await post(base, `/api/conversations/nope`, { title: "x" })).status, 404);
  } finally {
    server.close(); server.closeAllConnections();
    home.close();
  }
});

test("proposals over HTTP: a run proposes, the user accepts once, or asks for a change", async () => {
  const proposing: EnginePort = {
    async submit(request) {
      const propose = request.tools.find((tool) => tool.name === "propose")!;
      const said = await propose.execute({ title: "删掉「Old」？", summary: "很久没动了。", calls: [{ tool: "todo_delete", params: { title: "Old" } }] }, new AbortController().signal);
      return { reply: said };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: proposing, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    await post(base, "/api/ops/todo.add", { requestId: "t1", input: { title: "Old" } });
    await post(base, "/api/runs", { requestId: "r1", goal: "tidy up" });
    await home.idle();
    const state = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    assert.equal(state.proposals.length, 1);
    const [proposal] = state.proposals;
    assert.equal(proposal.steps[0].op, "todo.delete");
    assert.equal((state.modules.todo as TodoSnapshot).todos.length, 1, "nothing changed until the user says yes");

    const accept = () => post(base, `/api/proposals/${proposal.id}/accept`, { requestId: "yes-1" });
    const first = await (await accept()).json() as { proposal: { state: string }; replayed: boolean };
    assert.deepEqual([first.proposal.state, first.replayed], ["executed", false]);
    const again = await (await accept()).json() as { replayed: boolean };
    assert.equal(again.replayed, true);
    const after = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    assert.equal((after.modules.todo as TodoSnapshot).todos.length, 0);
    assert.equal(after.proposals.length, 0);
    assert.equal((await post(base, `/api/proposals/${proposal.id}/decline`, { requestId: "no-1" })).status, 409);

    // The language is a device command too; the node's own text follows it.
    const settings = await (await post(base, "/api/settings", { requestId: "lang-1", patch: { locale: "zh" } })).json() as { locale: string };
    assert.equal(settings.locale, "zh");
    assert.equal((await post(base, "/api/settings", { requestId: "lang-2", patch: { locale: "fr" } })).status, 400);
    assert.equal(((await (await fetch(`${base}/api/state`)).json()) as StateResponse).settings.locale, "zh");

    // Asking for a change: this one is superseded and a new run in the same conversation revises it.
    await post(base, "/api/ops/todo.add", { requestId: "t2", input: { title: "Old" } });
    await post(base, "/api/runs", { requestId: "r2", goal: "tidy up again", conversationId: proposal.conversationId });
    await home.idle();
    const second = ((await (await fetch(`${base}/api/state`)).json()) as StateResponse).proposals[0];
    const revised = await (await post(base, `/api/proposals/${second.id}/revise`, { requestId: "change-1", text: "先别删，改成完成" })).json() as { proposal: { state: string }; run: { conversationId: string; goal: string } };
    assert.equal(revised.proposal.state, "superseded");
    assert.equal(revised.run.conversationId, second.conversationId);
    assert.match(revised.run.goal, /先别删，改成完成/);
    await home.idle();
  } finally {
    server.close(); server.closeAllConnections();
    home.close();
  }
});

test("asking from a page: the run keeps the page, the engine hears about it, a malformed page is refused", async () => {
  const heard: unknown[] = [];
  const listening: EnginePort = { async submit(request) { heard.push(request.context); return { reply: "Start with the report." }; } };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: listening, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const before = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    const context = { view: "todo.list", title: "Todos", summary: "3 open, 1 overdue" };
    const submitted = await post(base, "/api/runs", { requestId: "r-page", goal: "What should I do first today?", context });
    assert.equal(submitted.status, 202);
    const { run } = (await submitted.json()) as SubmitRunResponse;
    assert.deepEqual(run.context, context);
    await waitForEvent(base, before.cursor, (event) => event.kind === "run.completed");
    assert.deepEqual(heard, [context]);
    const detail = (await (await fetch(`${base}/api/conversations/${run.conversationId}`)).json()) as ConversationDetail;
    assert.deepEqual(detail.runs[0].context, context, "devices see where each question was asked");

    const refused = await post(base, "/api/runs", { requestId: "r-bad", goal: "x", context: { view: "../etc", summary: 3 } });
    assert.equal(refused.status, 400);
  } finally {
    server.close(); server.closeAllConnections();
    home.close();
  }
});

test("automations over HTTP: made by the user, fired once by the clock, unattended, run now, switched off", async () => {
  const seen: Array<{ tools: string[]; instructions: string; allowed: boolean; goal: string }> = [];
  const recording: EnginePort = {
    async submit(request) {
      seen.push({ tools: request.tools.map((tool) => tool.name), instructions: request.instructions, allowed: (await request.external.allow("Post this?")) !== "deny", goal: request.goal });
      return { reply: "Two todos are due today." };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: recording, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const initial = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    assert.deepEqual(initial.automations.map((automation) => [automation.template, automation.enabled]), [["brief", false]], "the brief is there, off");

    const now = Date.now();
    const soon = new Date(now + 60_000);
    const hhmm = `${String(soon.getHours()).padStart(2, "0")}:${String(soon.getMinutes()).padStart(2, "0")}`;
    const created = await post(base, "/api/automations", { requestId: "a-1", name: "Sweep", goal: "Look over my todos", schedule: { at: hhmm, days: [1, 2, 3, 4, 5, 6, 7] } });
    assert.equal(created.status, 200);
    const automation = (await created.json()) as StateResponse["automations"][number];
    assert.equal(automation.nextAt !== null, true);
    assert.equal((await post(base, "/api/automations", { requestId: "a-1", name: "Sweep", goal: "Look over my todos", schedule: { at: hhmm, days: [1, 2, 3, 4, 5, 6, 7] } })).status, 200, "a retry replays");
    assert.equal((await post(base, "/api/automations", { requestId: "a-2", name: "Bad", goal: "x", schedule: { at: "7:30", days: [1] } })).status, 400);

    const slot = Date.parse(automation.nextAt!);
    assert.equal(home.tickAutomations(slot + 1000).length, 1);
    assert.equal(home.tickAutomations(slot + 2000).length, 0, "once per slot");
    await home.idle();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].goal, "Look over my todos");
    assert.equal(seen[0].allowed, false, "nobody to allow an external call");
    assert.ok(!seen[0].tools.includes("ask_user") && !seen[0].tools.includes("todo_delete"), "nothing that asks, nothing irreversible");
    assert.ok(seen[0].tools.includes("propose") && seen[0].tools.includes("todo_add"));
    assert.match(seen[0].instructions, /nobody is watching/);

    const ran = await post(base, `/api/automations/${automation.id}/run`, { requestId: "a-run" });
    assert.equal(ran.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await home.idle();
    const after = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    const mine = after.automations.find((candidate) => candidate.id === automation.id)!;
    assert.equal(mine.lastRun?.state, "completed");
    assert.equal(mine.lastRun?.reply, "Two todos are due today.");
    const detail = (await (await fetch(`${base}/api/conversations/${mine.conversationId}`)).json()) as ConversationDetail;
    assert.deepEqual(detail.runs.map((run) => run.automationId), [automation.id, automation.id], "both runs went to its conversation");

    const off = await post(base, `/api/automations/${automation.id}`, { requestId: "a-off", patch: { enabled: false } });
    assert.equal(((await off.json()) as StateResponse["automations"][number]).nextAt, null);
    assert.equal(home.tickAutomations(slot + 24 * 3600_000).length, 0, "off: the next day's slot does not fire");
    assert.equal((await post(base, `/api/automations/${automation.id}/delete`, { requestId: "a-del" })).status, 200);
    assert.equal((await post(base, `/api/automations/${automation.id}`, { requestId: "a-gone", patch: { enabled: true } })).status, 404);
  } finally {
    server.close(); server.closeAllConnections();
    home.close();
  }
});

test("Alfred can list, make and change automations when asked; an automation's own run cannot", async () => {
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule] });
  try {
    const all = profiles(home.world, [todoModule]);
    const tool = (name: string) => all[ASSISTANT_PROFILE].tools.find((candidate) => candidate.name === name)!;
    const signal = new AbortController().signal;
    const made = await tool("automation_add").execute({ name: "Monday sweep", goal: "Go over my todos", at: "08:30", days: [1] }, signal);
    assert.match(made, /Made the automation "Monday sweep"/);
    const listed = await tool("automation_list").execute({}, signal);
    assert.match(listed, /Monday sweep \| weekdays 1 at 08:30 \| on/);
    assert.match(listed, /Morning brief .*\| off/, "the brief, by its name in the user's language");
    const id = listed.split("\n").find((line) => line.includes("Monday sweep"))!.split(":")[0];
    assert.match(await tool("automation_update").execute({ id, at: "09:00", enabled: false }, signal), /at 09:00 \| off/);
    assert.match(await tool("automation_add").execute({ name: "Bad", goal: "x", at: "8:30" }, signal), /^Not done: /);

    const unattended = all[AUTOMATION_PROFILE];
    assert.equal(unattended.unattended, true);
    assert.deepEqual(unattended.tools.map((candidate) => candidate.name).filter((name) => name.startsWith("automation_") || name === "ask_user"), ["automation_list"]);
  } finally {
    home.close();
  }
});

test("a development session: add and trust a folder, start a session, and its runs read that folder", async () => {
  const seen: Array<{ workspace?: unknown; context?: unknown; tools: string[]; instructions: string }> = [];
  const coder: EnginePort = { async submit(request) { seen.push({ workspace: request.workspace, context: request.context, tools: request.tools.map((tool) => tool.name), instructions: request.instructions }); return { reply: "It is in src/" }; } };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: coder, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const folder = mkdtempSync(join(tmpdir(), "alfred-code-"));
    const project = await (await post(base, "/api/projects", { path: folder, name: "Shop" })).json() as { id: string; trustedAt: string | null; path: string };
    assert.equal(project.trustedAt, null);
    // Untrusted: no session yet.
    assert.equal((await post(base, "/api/conversations", { projectId: project.id, title: "Where is checkout?" })).status, 409);
    assert.ok(((await (await post(base, `/api/projects/${project.id}/trust`, {})).json()) as { trustedAt: string }).trustedAt);
    const created = await post(base, "/api/conversations", { projectId: project.id, title: "Where is checkout?" });
    assert.equal(created.status, 201);
    const session = await created.json() as { id: string; projectId: string };
    assert.equal(session.projectId, project.id);

    const submitted = await (await post(base, "/api/runs", { requestId: "dev-1", goal: "Where is checkout?", conversationId: session.id, context: { view: "todo.list" } })).json() as SubmitRunResponse;
    assert.equal(submitted.run.profile, "developer");
    await home.idle();
    const detail = await (await fetch(`${base}/api/conversations/${session.id}`)).json() as ConversationDetail;
    assert.equal(detail.runs[0].state, "completed");
    assert.deepEqual(seen[0].workspace, { root: project.path, name: "Shop", mode: "ask" });
    assert.equal(seen[0].context, undefined, "a session is not asked from a page");
    assert.ok(!seen[0].tools.includes("show_view"));
    assert.match(seen[0].instructions, /ask mode: you can change files/, "the run is told what its mode lets it do");
    assert.doesNotMatch(seen[0].instructions, /cannot change files/);

    const state = await (await fetch(`${base}/api/state`)).json() as StateResponse;
    assert.deepEqual(state.projects.map((candidate) => candidate.name), ["Shop"]);
  } finally {
    server.close();
    home.close();
  }
});

test("calendar and mail over HTTP: a refresh reads Google, the state carries the mirror, a body is a query", async () => {
  const { calendarModule } = await import("@alfred/module-calendar");
  const { mailModule } = await import("@alfred/module-mail");
  const today = new Date();
  const at = (hours: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), hours).toISOString();
  const google = {
    accounts: () => [{ email: "me@example.com", capabilities: ["calRead", "mailRead"] }],
    async session() {
      return {
        async send(): Promise<{ status: number; body: Record<string, unknown> }> { throw new Error("no writes in this test"); },
        async get(url: string): Promise<Record<string, unknown>> {
          if (url.includes("/calendarList")) return { items: [{ id: "primary", summary: "Me", primary: true }] };
          if (url.includes("/events")) return { items: [{ id: "e1", summary: "Design review", start: { dateTime: at(15) }, end: { dateTime: at(16) } }] };
          if (/\/messages\?/.test(url)) return { messages: [{ id: "m1" }] };
          return { id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.now()), snippet: "Can you sign?",
            payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Leo <leo@example.com>" }, { name: "Subject", value: "Contract" }], body: { data: Buffer.from("Please sign by Friday.").toString("base64url") } } };
        },
      };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule, calendarModule, mailModule], services: () => ({ google }) });
  const { server, base } = await start(home);
  try {
    assert.equal((await post(base, "/api/modules/calendar/sync", {})).status, 200);
    assert.equal((await post(base, "/api/modules/mail/sync", {})).status, 200);
    assert.equal((await post(base, "/api/modules/todo/sync", {})).status, 404, "todos mirror nothing");
    const state = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    const calendar = state.modules.calendar as { events: Array<{ title: string }> };
    const mail = state.modules.mail as { messages: Array<{ subject: string; unread: boolean }> };
    assert.deepEqual(calendar.events.map((event) => event.title), ["Design review"]);
    assert.deepEqual(mail.messages.map((message) => [message.subject, message.unread]), [["Contract", true]]);
    assert.deepEqual(state.views.calendar, [{ id: "week", title: "Calendar" }]);

    const query = await post(base, "/api/queries/mail.message", { input: { id: "m1" } });
    assert.equal(((await query.json()) as { result: { body: string } }).result.body, "Please sign by Friday.");
    assert.equal((await post(base, "/api/queries/mail.nothing", { input: {} })).status, 404);
    assert.equal((await post(base, "/api/queries/mail.message", { input: { id: 7 } })).status, 400);

    const all = profiles(home.world, [todoModule, calendarModule, mailModule]);
    for (const profile of [ASSISTANT_PROFILE, AUTOMATION_PROFILE]) {
      const names = all[profile].tools.map((tool) => tool.name);
      assert.ok(["calendar_list", "mail_list", "mail_read"].every((name) => names.includes(name)), `${profile} can read the calendar and mail`);
    }
  } finally {
    server.close(); server.closeAllConnections();
    home.close();
  }
});

test("a session that edits: changes since its snapshot, one file's diff, and 'don't ask again' switching it to edits", async () => {
  const folder = mkdtempSync(join(tmpdir(), "alfred-repo-"));
  const sh = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { stdio: "pipe" });
  sh("init", "-q");
  sh("config", "user.email", "test@example.com");
  sh("config", "user.name", "Test");
  writeFileSync(join(folder, "a.txt"), "one\n");
  writeFileSync(join(folder, "b.txt"), "bee\n");
  sh("add", ".");
  sh("commit", "-qm", "start");
  // The user's own edit from before the session: not the session's change.
  writeFileSync(join(folder, "b.txt"), "bee\nmine\n");

  const editing: EnginePort = {
    async submit(request) {
      const answer = await request.external.allow("Change a.txt?", { detail: "--- a.txt\n+++ a.txt\n+two", always: true });
      if (answer === "deny") return { reply: "Left it." };
      appendFileSync(join(folder, "a.txt"), "two\n");
      request.external.changed?.({ path: "a.txt", added: 1, removed: 0, created: false });
      writeFileSync(join(folder, "new.txt"), "x\ny\n");
      request.external.changed?.({ path: "new.txt", added: 2, removed: 0, created: true });
      return { reply: `Done (${answer}).` };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: editing, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const project = await (await post(base, "/api/projects", { path: folder })).json() as { id: string };
    assert.equal((await post(base, "/api/conversations", { projectId: project.id, title: "Add a line" })).status, 409);
    assert.equal(String(sh("for-each-ref", "refs/alfred")), "", "nothing is done in a folder before it is trusted");
    await post(base, `/api/projects/${project.id}/trust`, {});
    const session = await (await post(base, "/api/conversations", { projectId: project.id, title: "Add a line", mode: "ask" })).json() as { id: string; mode: string; base: string | null };
    assert.equal(session.mode, "ask");
    assert.match(String(session.base), /^[0-9a-f]{40}$/);
    // The snapshot is a commit on no branch: a ref of Alfred's keeps git from collecting it.
    assert.match(String(sh("for-each-ref", "refs/alfred/snapshots")), new RegExp(`^${session.base} `));
    sh("gc", "-q", "--prune=now");
    const { run } = await (await post(base, "/api/runs", { requestId: "edit-1", goal: "Add a line", conversationId: session.id })).json() as SubmitRunResponse;

    let detail: ConversationDetail;
    for (;;) {
      detail = await (await fetch(`${base}/api/conversations/${session.id}`)).json() as ConversationDetail;
      if (detail.runs[0].request) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const asked = detail.runs[0].request!;
    assert.deepEqual(asked.options, ["allow", "deny", "always"]);
    assert.match(String(asked.detail), /\+two/);
    assert.equal((await post(base, `/api/runs/${run.id}/respond`, { requestId: asked.id, answer: "always" })).status, 200);
    await home.idle();

    detail = await (await fetch(`${base}/api/conversations/${session.id}`)).json() as ConversationDetail;
    assert.equal(detail.runs[0].outcome?.reply, "Done (always).");
    assert.equal(detail.conversation.mode, "edits", "don't ask again: the session now changes files without asking");
    assert.deepEqual(detail.receipts[run.id].map((event) => event.kind), ["file.changed", "file.changed"]);

    const changes = await (await fetch(`${base}/api/conversations/${session.id}/changes`)).json() as SessionChanges;
    assert.deepEqual(changes.files, [
      { path: "a.txt", added: 1, removed: 0, created: false },
      { path: "new.txt", added: 2, removed: 0, created: true },
    ], "b.txt was changed before the session, so it is not listed");
    assert.ok(changes.branch);
    const diff = await (await fetch(`${base}/api/conversations/${session.id}/diff?path=a.txt`)).json() as { diff: string };
    assert.match(diff.diff, /^\+two$/m);
    assert.match(((await (await fetch(`${base}/api/conversations/${session.id}/diff?path=new.txt`)).json()) as { diff: string }).diff, /^\+y$/m);
    assert.equal(((await (await fetch(`${base}/api/conversations/${session.id}/diff?path=../b.txt`)).json()) as { diff: unknown }).diff, null);
  } finally {
    server.close();
    home.close();
  }
});

test("a change accepted while its module is syncing goes out right after that pass, not at the next one", async () => {
  let finishReading!: () => void;
  const reading = new Promise<void>((resolve) => { finishReading = resolve; });
  let passes = 0;
  const outbox = defineModule({
    id: "outbox", title: "Outbox", migrations: [], ops: [], tools: [],
    sync: { everyMs: 3_600_000, async run(world) {
      passes++;
      for (let next = claimOutbound(world, "outbox"); next; next = claimOutbound(world, "outbox")) finishOutbound(world, next.id, { state: "done" });
      if (passes === 1) await reading; // the first pass is past its delivery step, reading the service
    } },
  });
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [outbox] });
  try {
    const first = home.syncModule("outbox");
    await new Promise((resolve) => setImmediate(resolve));
    withCoreContext({ actor: "user" }, () => enqueueOutbound(home.world, { module: "outbox", action: "send", payload: {}, preview: "An email", idempotent: false }));
    home.deliver(); // as after a proposal is accepted
    assert.equal(listOutbound(home.world)[0].state, "queued");
    finishReading();
    await first;
    for (let i = 0; i < 50 && listOutbound(home.world)[0].state !== "done"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(listOutbound(home.world)[0].state, "done");
    assert.equal(passes, 2, "one more pass, right away");
  } finally {
    home.close();
  }
});

test("calendar and mail changes over HTTP: proposed by a run, delivered right after the user's yes, the outcome told", async () => {
  const { calendarModule } = await import("@alfred/module-calendar");
  const { mailModule } = await import("@alfred/module-mail");
  const sent: string[] = [];
  const google = {
    accounts: () => [{ email: "me@example.com", capabilities: ["calRead", "calWrite", "mailRead", "mailSend"] }],
    async session() {
      return {
        async get(url: string): Promise<Record<string, unknown>> {
          if (url.includes("/calendarList")) return { items: [{ id: "primary", summary: "Me", primary: true, accessRole: "owner" }] };
          if (url.includes("/events")) return { items: [] };
          return { messages: [] };
        },
        async send(method: string, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
          sent.push(`${method} ${url.split("/v3")[1] ?? url.split("/v1")[1]}`);
          return { status: 200, body: { id: "x" } };
        },
      };
    },
  };
  const proposing: EnginePort = {
    async submit(request) {
      const propose = request.tools.find((tool) => tool.name === "propose")!;
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      return { reply: await propose.execute({ title: "Hold time and tell Ana?", summary: "", calls: [
        { tool: "calendar_add", params: { title: "Write the plan", date: tomorrow } },
        { tool: "mail_send", params: { to: ["ana@example.com"], subject: "Plan", body: "I'll have it tomorrow." } },
      ] }, new AbortController().signal) };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: proposing, modules: [todoModule, calendarModule, mailModule], services: () => ({ google }) });
  const { server, base } = await start(home);
  try {
    await home.syncModule("calendar");
    await home.syncModule("mail");
    const all = profiles(home.world, [todoModule, calendarModule, mailModule]);
    for (const profile of Object.values(all)) {
      assert.ok(!profile.tools.some((tool) => ["calendar_add", "calendar_move", "calendar_respond", "mail_send"].includes(tool.name)), "no profile calls them directly");
      // They are reached only through `propose`, so that is where a run reads their parameters.
      const calls = JSON.stringify(profile.tools.find((tool) => tool.name === "propose")!.parameters);
      for (const name of ["reply_to", "end_date", "response"]) assert.ok(calls.includes(`"${name}"`), `propose says how to call them (${name})`);
    }
    await post(base, "/api/runs", { requestId: "w-1", goal: "Hold tomorrow for the plan and tell Ana" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await home.idle();
    assert.equal(sent.length, 0, "proposed only");
    const [proposal] = ((await (await fetch(`${base}/api/state`)).json()) as StateResponse).proposals;
    assert.equal(proposal.steps[1].detail, "To: ana@example.com\nSubject: Plan\n\nI'll have it tomorrow.");

    assert.equal((await post(base, `/api/proposals/${proposal.id}/accept`, { requestId: "w-accept" })).status, 200);
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await home.syncModule("calendar");
    await home.syncModule("mail");
    assert.deepEqual(sent.map((line) => line.split(" ")[0]), ["POST", "POST"]);
    assert.ok(sent.some((line) => line.includes("/calendars/primary/events")) && sent.some((line) => line.includes("/messages/send")));
    const after = (await (await fetch(`${base}/api/state`)).json()) as StateResponse;
    const told = after.notices.filter((notice) => notice.kind === "outbound").map((notice) => [notice.payload.state, notice.payload.proposalId]);
    assert.deepEqual(told, [["done", proposal.id], ["done", proposal.id]]);
  } finally {
    server.close(); server.closeAllConnections();
    home.close();
  }
});
