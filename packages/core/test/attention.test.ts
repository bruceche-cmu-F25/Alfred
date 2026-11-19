import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acknowledgeNotice, ATTENTION, claimNotice, CORE_MIGRATIONS, createNotice, decide, listEvents, listNotices, noticeClass, openWorld, pendingNotices,
  presentNotice, recordDomainEvent, reportPresence, type Outlet, type World,
} from "../src/index.ts";

const T0 = Date.parse("2026-11-19T09:00:00.000Z");
const made = new Date(T0).toISOString();
/** Notices as they are made: a run's result, a question, a proposal, an interrupted run, and how a change outside went. */
const NOTICES = {
  result: { kind: "run_result", payload: { status: "completed" } },
  question: { kind: "run_request", payload: { kind: "input" } },
  proposal: { kind: "proposal", payload: {} },
  interrupted: { kind: "run_interrupted", payload: {} },
  sent: { kind: "outbound", payload: { state: "done" } },
  refused: { kind: "outbound", payload: { state: "failed" } },
  unsure: { kind: "outbound", payload: { state: "unknown" } },
  welcome: { kind: "welcome", payload: {} },
} as const;
const notice = (name: keyof typeof NOTICES) => ({ kind: NOTICES[name].kind, class: noticeClass(NOTICES[name].kind, NOTICES[name].payload), createdAt: made });

const windowOutlet = (id: string, attending: boolean, activeAt = 0): Outlet => ({ id, kind: "window", attending, activeAt });
const figure = (attending: boolean): Outlet => ({ id: "mac.figure", kind: "figure", attending });
const push: Outlet = { id: "push", kind: "push", attending: false };
const after = (ms: number) => T0 + ms;

test("what a notice is to the user: it waits on them, it is news, or it is the welcome", () => {
  const classes = Object.fromEntries(Object.keys(NOTICES).map((name) => [name, notice(name as keyof typeof NOTICES).class]));
  assert.deepEqual(classes, {
    question: "needs_you", proposal: "needs_you", interrupted: "needs_you", refused: "needs_you", unsure: "needs_you",
    result: "tells_you", sent: "tells_you",
    welcome: "greeting",
  });
  assert.equal(noticeClass("reminder", {}), "tells_you", "a kind that has no place in the list yet is news");
});

test("every notice says which it is, read from its kind and what it carries", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  world.tx((db) => {
    const event = recordDomainEvent(world, { kind: "outbound.unknown", payload: {} });
    createNotice(db, { eventSeq: event.seq, kind: "outbound", payload: { state: "unknown", preview: "Email Ana" } });
    createNotice(db, { eventSeq: event.seq, kind: "run_result", payload: { status: "completed" } });
  });
  assert.deepEqual(listNotices(world).map((item) => [item.kind, item.class]), [["outbound", "needs_you"], ["run_result", "tells_you"]]);
  world.close();
});

test("row 1: a window in use gets it at once, and of several the one used last", () => {
  const outlets = [windowOutlet("phone.window", true, 50), windowOutlet("mac.window", true, 90), windowOutlet("tab", false, 99), figure(true), push];
  for (const name of ["result", "question", "proposal", "interrupted", "sent", "refused", "unsure"] as const) {
    assert.deepEqual(decide(notice(name), outlets, after(0)), { do: "tell", outlet: "mac.window" }, name);
  }
});

test("row 2: at the Mac but not looking, the figure says it, once a window has had its chance", () => {
  const outlets = [windowOutlet("mac.window", false), figure(true), push];
  assert.deepEqual(decide(notice("result"), outlets, after(400)), { do: "wait", until: after(ATTENTION.figureAfterMs) });
  assert.deepEqual(decide(notice("result"), outlets, after(ATTENTION.figureAfterMs)), { do: "tell", outlet: "mac.figure" });
  assert.deepEqual(decide(notice("unsure"), outlets, after(60_000)), { do: "tell", outlet: "mac.figure" }, "and not the phone while the user is at the Mac");
});

test("row 3: at no device, what needs the user and a run's result go to the phone after a wait; 'it went through' does not", () => {
  const outlets = [windowOutlet("mac.window", false), figure(false), push];
  for (const name of ["result", "question", "proposal", "interrupted", "refused", "unsure"] as const) {
    assert.deepEqual(decide(notice(name), outlets, after(5_000)), { do: "wait", until: after(ATTENTION.pushAfterMs) }, name);
    assert.deepEqual(decide(notice(name), outlets, after(ATTENTION.pushAfterMs)), { do: "tell", outlet: "push" }, name);
  }
  assert.deepEqual(decide(notice("sent"), outlets, after(ATTENTION.pushAfterMs)), { do: "wait", until: "return" });
});

test("row 4: otherwise it waits for the user's return", () => {
  // No phone has notifications on.
  assert.deepEqual(decide(notice("question"), [windowOutlet("mac.window", false), figure(false)], after(60_000)), { do: "wait", until: "return" });
  assert.deepEqual(decide(notice("question"), [], after(60_000)), { do: "wait", until: "return" });
  // Found too late to be news (the home node was off): no buzz for it.
  assert.deepEqual(decide(notice("result"), [push], after(ATTENTION.pushWhileFreshMs + 1)), { do: "wait", until: "return" });
  assert.deepEqual(decide(notice("result"), [push], after(ATTENTION.pushWhileFreshMs)), { do: "tell", outlet: "push" });
});

test("an outlet that was handed a notice and did not present it is passed over", () => {
  const outlets = [windowOutlet("mac.window", true, 90), windowOutlet("phone.window", true, 50), figure(true), push];
  assert.deepEqual(decide(notice("question"), outlets, after(30_000), { tried: new Set(["mac.window"]) }), { do: "tell", outlet: "phone.window" });
  assert.deepEqual(decide(notice("question"), outlets, after(30_000), { tried: new Set(["mac.window", "phone.window"]) }), { do: "tell", outlet: "mac.figure" });
  assert.deepEqual(decide(notice("question"), outlets, after(30_000), { tried: new Set(["mac.window", "phone.window", "mac.figure"]) }), { do: "tell", outlet: "push" });
  assert.deepEqual(decide(notice("question"), outlets, after(30_000), { tried: new Set(["mac.window", "phone.window", "mac.figure", "push"]) }), { do: "wait", until: "return" });
});

test("the welcome is not this table's: it goes to the device that saw the user come back", () => {
  assert.deepEqual(decide(notice("welcome"), [windowOutlet("mac.window", true), figure(true), push], after(60_000)), { do: "nothing" });
});

test("the waits are the policy's, in one place", () => {
  const policy = { ...ATTENTION, figureAfterMs: 0, pushAfterMs: 1_000, pushes: () => true };
  assert.deepEqual(decide(notice("result"), [figure(true)], after(0), { policy }), { do: "tell", outlet: "mac.figure" });
  assert.deepEqual(decide(notice("sent"), [push], after(1_000), { policy }), { do: "tell", outlet: "push" });
});

const told = (world: World, kind: string, now = Date.now()) => world.tx((db) => {
  const event = recordDomainEvent(world, { kind: "run.completed", payload: {}, now });
  return createNotice(db, { eventSeq: event.seq, kind, payload: {}, now });
});

test("who a notice was handed to and where it was shown are events; holding on to it longer is not", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const now = Date.now();
  const first = told(world, "run_result", now), second = told(world, "proposal", now);
  const before = listEvents(world).cursor;
  claimNotice(world, first.id, "mac.figure", { now });
  claimNotice(world, first.id, "mac.figure", { now: now + 5_000 }); // the same holder, a little longer
  presentNotice(world, first.id, "mac.figure", { now: now + 6_000 });
  presentNotice(world, first.id, "mac.figure", { now: now + 7_000 });
  acknowledgeNotice(world, first.id, { now: now + 8_000 });
  // The phone held the second one; its hold ran out, and the Mac took it over.
  claimNotice(world, second.id, "push", { now, ttlMs: 1_000 });
  claimNotice(world, second.id, "mac.figure", { now: now + 9_000 });
  assert.deepEqual(listEvents(world, { after: before }).events.map((event) => [event.kind, event.payload.kind, event.payload.to ?? event.payload.by ?? null, event.actor]), [
    ["notice.assigned", "run_result", "mac.figure", "system"],
    ["notice.presented", "run_result", "mac.figure", "system"],
    ["notice.acknowledged", "run_result", null, "user"],
    ["notice.assigned", "proposal", "push", "system"],
    ["notice.assigned", "proposal", "mac.figure", "system"],
  ]);
  assert.deepEqual(pendingNotices(world), [], "neither is anybody's to take any more");
  world.close();
});

test("the welcome is handed to the device that saw the return; handing notices about is not counted as Alfred's work", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const now = Date.now(), hour = 3_600_000;
  reportPresence(world, { clientId: "mac", kind: "active", now: now - 5 * hour });
  reportPresence(world, { clientId: "mac", kind: "away", now: now - 4 * hour });
  const result = told(world, "run_result", now - 3 * hour);
  claimNotice(world, result.id, "push", { now: now - 3 * hour + 20_000, ttlMs: 12 * hour });
  const { notice: welcome } = reportPresence(world, { clientId: "mac", kind: "active", now });
  assert.deepEqual(welcome!.payload.changes, {});
  assert.deepEqual(listEvents(world).events.filter((event) => event.kind === "notice.assigned").map((event) => [event.payload.kind, event.payload.to]), [["run_result", "push"], ["welcome", "mac"]]);
  world.close();
});
