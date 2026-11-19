import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTENTION, claimNotice, CORE_MIGRATIONS, createNotice, listEvents, listNotices, openWorld, recordDomainEvent, type World } from "@alfred/core";
import { watchAttention, type Reach } from "../src/index.ts";

/** The table, with a short wait before a notice nobody took is the phone's. */
const policy = { ...ATTENTION, pushAfterMs: 40 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);
const make = (w: World, kind = "run_request", payload: Record<string, unknown> = {}) => w.tx((db) => {
  const event = recordDomainEvent(w, { kind: "run.waiting", payload: {} });
  return createNotice(db, { eventSeq: event.seq, kind, payload });
});
/** The phones, as an outlet: `sent` gets what it was asked to tell; `goesOut` is whether a push service took it. */
const phone = (sent: string[], goesOut = true): Reach => ({
  outlet: { id: "push", kind: "push", attending: false }, holdMs: 60_000,
  send: async (notice) => { sent.push(notice.id); return goesOut; },
});

test("a notice nobody took is handed where the table says, when it says, once, and that is recorded", async () => {
  const w = world();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, reaches: () => [phone(sent)], policy });
  try {
    const left = make(w), taken = make(w);
    claimNotice(w, taken.id, "mac.figure"); // a device takes this one while the table waits
    await wait(10);
    assert.deepEqual(sent, [], "not before the table's wait is over");
    await wait(120);
    assert.deepEqual(sent, [left.id]);
    assert.deepEqual(listEvents(w).events.filter((event) => event.kind === "notice.assigned").map((event) => [event.payload.noticeId, event.payload.to]),
      [[taken.id, "mac.figure"], [left.id, "push"]]);
    // Neither of these is the phone's: the welcome, and a change outside that simply went through.
    make(w, "welcome");
    make(w, "outbound", { state: "done" });
    await wait(120);
    assert.equal(sent.length, 1);
  } finally { attention.close(); w.close(); }
});

test("an outlet that does not take a notice is not asked again, and the notice keeps waiting", async () => {
  const w = world();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, reaches: () => [phone(sent, false)], policy });
  try {
    const first = make(w);
    await wait(120);
    const second = make(w, "proposal"); // something else happens: the first is looked at again, and left alone
    await wait(120);
    assert.deepEqual(sent, [first.id, second.id]);
    assert.deepEqual(listNotices(w).map((notice) => notice.state), ["pending", "pending"]);
  } finally { attention.close(); w.close(); }
});

test("with no outlet to hand to, nothing is decided until there is one", async () => {
  const w = world();
  const sent: string[] = [];
  let reaches: Reach[] = [];
  const attention = watchAttention({ world: w, reaches: () => reaches, policy });
  try {
    const left = make(w);
    await wait(100);
    assert.deepEqual(sent, []);
    reaches = [phone(sent)]; // a phone turns notifications on
    make(w, "welcome"); // the next thing that happens
    await wait(60);
    assert.deepEqual(sent, [left.id]);
  } finally { attention.close(); w.close(); }
});

test("closed, it hands nothing on", async () => {
  const w = world();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, reaches: () => [phone(sent)], policy });
  make(w);
  attention.close();
  await wait(120);
  assert.deepEqual(sent, []);
  w.close();
});
