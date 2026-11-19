import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptProposal, CORE_MIGRATIONS, declineProposal, getProposal, listEvents, listNotices, listOpenProposals, openProposal, openWorld,
  ProposalStateError, PROPOSAL_TTL_MS, recordDomainEvent, runCommand, supersedeProposal, withCoreContext, type ProposalStep, type World,
} from "../src/index.ts";

const TOY = { id: "toy:1", sql: "CREATE TABLE toys (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) STRICT;" };
const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, TOY]);

function addToy(w: World, name: string): void {
  w.tx((db) => {
    db.prepare("INSERT INTO toys (id, name) VALUES (?, ?)").run(name, name);
    recordDomainEvent(w, { kind: "toy.added", subject: `toy:${name}`, payload: { name } });
  });
}
/** A stand-in for module-kit's applyStep: the step names a toy to remove. */
const removeToy = (w: World) => (step: ProposalStep) => w.tx((db) => {
  const name = (step.input as { name: string }).name;
  if (!db.prepare("DELETE FROM toys WHERE id = ?").run(name).changes) throw new Error(`no toy ${name}`);
  recordDomainEvent(w, { kind: "toy.removed", subject: `toy:${name}`, payload: { name } });
});
const toys = (w: World) => w.db.prepare("SELECT id FROM toys ORDER BY id").all().map((row) => row.id);
const propose = (w: World, names: string[]) => withCoreContext({ actor: "alfred" }, () => openProposal(w, {
  title: `Remove ${names.join(", ")}?`, summary: "Nobody plays with them.",
  steps: names.map((name) => ({ op: "toy.remove", input: { name }, preview: `Remove ${name}` })), subjects: names.map((name) => `toy:${name}`),
}));

test("accepting runs exactly the previewed steps, once, and records what they wrote", () => {
  const w = world();
  addToy(w, "ball"); addToy(w, "kite"); addToy(w, "yoyo");
  const proposal = propose(w, ["ball", "kite"]);
  assert.equal(listOpenProposals(w).length, 1);
  assert.deepEqual(listNotices(w).map((notice) => notice.kind), ["proposal"]);

  const accept = () => withCoreContext({ actor: "user" }, () =>
    runCommand(w, { requestId: "d1", command: "proposal.accept", input: { id: proposal.id } }, () => acceptProposal(w, proposal.id, removeToy(w))));
  const first = accept();
  assert.equal(first.result.state, "executed");
  assert.equal(first.result.outcome?.receipts?.length, 2);
  assert.deepEqual(toys(w), ["yoyo"]);
  // The same click again replays; nothing runs twice.
  assert.equal(accept().replayed, true);
  assert.deepEqual(toys(w), ["yoyo"]);
  assert.throws(() => acceptProposal(w, proposal.id, removeToy(w)), ProposalStateError);

  const kinds = listEvents(w).events.map((event) => `${event.kind}:${event.actor}`);
  assert.deepEqual(kinds.slice(-4), ["proposal.decided:user", "toy.removed:user", "toy.removed:user", "proposal.executed:user"]);
  assert.equal(listOpenProposals(w).length, 0);
  assert.equal(listNotices(w).length, 0, "its notice is closed once decided");
});

test("a proposal whose records changed since goes stale and runs nothing", () => {
  const w = world();
  addToy(w, "ball");
  const proposal = propose(w, ["ball"]);
  w.tx(() => recordDomainEvent(w, { kind: "toy.renamed", subject: "toy:ball", payload: {} }));
  assert.equal(listOpenProposals(w)[0].stale, true);
  assert.equal(acceptProposal(w, proposal.id, removeToy(w)).state, "stale");
  assert.deepEqual(toys(w), ["ball"]);
});

test("a step that fails rolls every step back", () => {
  const w = world();
  addToy(w, "ball");
  const proposal = propose(w, ["ball", "ghost"]);
  const result = acceptProposal(w, proposal.id, removeToy(w));
  assert.equal(result.state, "failed");
  assert.match(result.outcome?.error ?? "", /no toy ghost/);
  assert.deepEqual(toys(w), ["ball"], "the first step was undone with the second");
});

test("declined, superseded and expired proposals leave the inbox", () => {
  const w = world();
  addToy(w, "ball");
  const a = propose(w, ["ball"]), b = propose(w, ["ball"]), c = propose(w, ["ball"]);
  assert.equal(declineProposal(w, a.id).state, "declined");
  assert.equal(supersedeProposal(w, b.id, "only the red one").state, "superseded");
  assert.throws(() => declineProposal(w, a.id), ProposalStateError);
  const later = Date.parse(c.createdAt) + PROPOSAL_TTL_MS + 1;
  assert.equal(listOpenProposals(w, later).length, 0);
  assert.equal(acceptProposal(w, c.id, removeToy(w), later).state, "expired");
  assert.deepEqual(toys(w), ["ball"]);
  assert.equal(getProposal(w, b.id).decidedAt !== null, true);
});
