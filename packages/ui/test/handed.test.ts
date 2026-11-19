import assert from "node:assert/strict";
import { test } from "node:test";
import { handed } from "../src/handed.ts";

test("a window shows only what the home node handed to it, and never takes a notice for itself", () => {
  const me = "web-1";
  assert.equal(handed({ state: "claimed", claimedBy: me }, me), "show");
  assert.equal(handed({ state: "pending", claimedBy: null }, me), null, "nobody's yet: the home node decides who gets it");
  assert.equal(handed({ state: "claimed", claimedBy: "mac-1" }, me), null, "the Mac's figure has it");
  assert.equal(handed({ state: "claimed", claimedBy: "push" }, me), null, "it went to the phone");
});

test("what was shown here before a reload is put back here, and nowhere else", () => {
  assert.equal(handed({ state: "presented", claimedBy: "web-1" }, "web-1"), "again");
  assert.equal(handed({ state: "presented", claimedBy: "web-1" }, "web-2"), null);
  assert.equal(handed({ state: "acknowledged", claimedBy: null }, "web-1"), null);
});
