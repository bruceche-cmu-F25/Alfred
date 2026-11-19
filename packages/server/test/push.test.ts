import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimNotice, CORE_MIGRATIONS, createNotice, listNotices, openWorld, pairDevice, recordDomainEvent, revokeDevice, type World } from "@alfred/core";
import { checkSubscription, noticeMessage, PushService, type PushSender } from "../src/index.ts";
import type { SecretStore } from "../src/secrets.ts";

const APPLE = { endpoint: "https://web.push.apple.com/QGx1a2V", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };

const memorySecrets = (): SecretStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    kind: "file", values,
    get: async (name) => values.get(name),
    set: async (name, value) => { values.set(name, value); },
    delete: async (name) => { values.delete(name); },
  };
};

function notice(world: World, kind = "run_result", payload: Record<string, unknown> = { goal: "Book the dentist", reply: "Booked for Friday 3pm.", conversationId: "c1", status: "completed" }) {
  return world.tx((db) => {
    const event = recordDomainEvent(world, { kind: "run.completed", payload: {} });
    return createNotice(db, { eventSeq: event.seq, kind, payload });
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setUp(send: PushSender) {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-push-"));
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const secrets = memorySecrets();
  const push = new PushService({ dataDir, world, secrets, send, graceMs: 40 });
  const phone = pairDevice(world, { token: "p".repeat(43), name: "iPhone", kind: "phone" });
  return { dataDir, world, secrets, push, phone };
}

test("only real push services are accepted as endpoints", () => {
  assert.equal(checkSubscription(APPLE).endpoint, APPLE.endpoint);
  assert.ok(checkSubscription({ ...APPLE, endpoint: "https://fcm.googleapis.com/fcm/send/abc" }));
  for (const endpoint of ["http://web.push.apple.com/x", "https://127.0.0.1/x", "https://evil.example/x", "https://push.apple.com.evil.example/x", "https://web.push.apple.com:8443/x", "nope"]) {
    assert.throws(() => checkSubscription({ ...APPLE, endpoint }), /push/i, endpoint);
  }
  assert.throws(() => checkSubscription({ endpoint: APPLE.endpoint, keys: { p256dh: "a b", auth: "x" } }));
});

test("a notice reads on a lock screen as on the Mac, in the user's language", () => {
  const done = noticeMessage({ id: "n1", kind: "run_result", payload: { goal: "Book", reply: "Booked for Friday.", conversationId: "c 1", status: "completed" } }, "en");
  assert.deepEqual(done, { tag: "notice:n1", notice: "n1", title: "Alfred", body: "Booked for Friday.", url: "/#c=c%201", ack: true });
  const proposal = noticeMessage({ id: "n2", kind: "proposal", payload: { title: "Move 3 todos to next week?" } }, "zh");
  assert.equal(proposal.title, "Alfred 有个提议等你决定");
  assert.equal(proposal.url, "/#p=core.inbox");
  assert.equal(proposal.ack, false);
  const question = noticeMessage({ id: "n3", kind: "run_request", payload: { kind: "input", question: "Which Friday?", conversationId: "c1" } }, "zh");
  assert.deepEqual([question.title, question.body, question.ack], ["Alfred 在等你回答", "Which Friday?", false]);
  assert.ok(noticeMessage({ id: "n4", kind: "run_result", payload: { reply: "x".repeat(500) } }, "en").body.length <= 200);
});

test("a notice nobody takes within the grace period goes to the phone once, and is then claimed by push", async () => {
  const sent: string[] = [];
  const { dataDir, world, secrets, push, phone } = setUp(async (subscription, payload) => { sent.push(`${subscription.endpoint} ${payload}`); });
  try {
    push.subscribe(phone.id, APPLE);
    assert.equal(statSync(join(dataDir, "push.json")).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(dataDir, "push.json"), "utf8").includes("privateKey"));
    push.watch();
    const left = notice(world);
    const taken = notice(world);
    claimNotice(world, taken.id, "mac");
    await wait(120);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Booked for Friday 3pm/);
    assert.ok(JSON.parse(secrets.values.get("push:vapid")!).privateKey);
    const [after] = listNotices(world, { states: ["claimed"] }).filter((item) => item.id === left.id);
    assert.equal(after.claimedBy, "push");
    // A later commit does not push it again.
    notice(world, "welcome", {});
    await wait(80);
    assert.equal(sent.length, 1);
  } finally { push.close(); world.close(); }
});

test("nothing is claimed when no push went out, and a gone subscription is dropped", async () => {
  const { world, push, phone } = setUp(async () => { throw Object.assign(new Error("Gone"), { statusCode: 410 }); });
  try {
    push.subscribe(phone.id, APPLE);
    push.watch();
    const left = notice(world);
    await wait(120);
    assert.equal(push.subscribed(phone.id), false);
    assert.equal(listNotices(world).find((item) => item.id === left.id)?.state, "pending");
  } finally { push.close(); world.close(); }
});

test("a revoked device gets nothing", async () => {
  const sent: string[] = [];
  const { world, push, phone } = setUp(async (subscription) => { sent.push(subscription.endpoint); });
  try {
    push.subscribe(phone.id, APPLE);
    revokeDevice(world, phone.id);
    const result = await push.sendTo({ title: "Alfred", body: "hi", url: "/", tag: "t" });
    assert.deepEqual(result, { accepted: 0, failed: 0, expired: 0 });
    assert.deepEqual(sent, []);
  } finally { push.close(); world.close(); }
});
