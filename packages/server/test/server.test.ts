import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EnginePort } from "@alfred/core";
import { todoModule, type TodoSnapshot } from "@alfred/module-todo";
import type { ConversationDetail, CoreEvent, RunDetail, StateResponse, SubmitRunResponse } from "@alfred/protocol";
import { createHttpServer, openHome, type Home } from "../src/index.ts";

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
    assert.deepEqual(state.views, { todo: [{ id: "list", title: "待办" }] });

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
