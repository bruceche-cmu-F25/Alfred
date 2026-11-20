import assert from "node:assert/strict";
import test from "node:test";
import { composerDraft } from "../src/composerDraft.ts";

test("a late upload and send finish in their original session without clearing newer edits", () => {
  const a = composerDraft("session-a"), b = composerDraft("session-b");
  a.setText("review this");
  a.setItems(() => [{ key: "first", name: "one.txt", size: 5, state: "uploading" }]);
  b.setText("different project");
  a.setItems((items) => items.map((item) => ({ ...item, state: "ready",
    file: { id: "upload1", name: item.name, size: item.size, type: "text/plain", kind: "text" } })));
  const reopened = composerDraft("session-a");
  assert.equal(reopened.snapshot().items[0]?.file?.id, "upload1");
  assert.equal(reopened.beginSend(), true);
  assert.equal(a.beginSend(), false);
  reopened.setText("next question");
  reopened.setItems((items) => [...items, { key: "next", name: "two.txt", size: 7, state: "uploading" }]);
  a.sent("review this", ["upload1"]);
  a.endSend();
  assert.equal(reopened.snapshot().text, "next question");
  assert.deepEqual(reopened.snapshot().items.map((item) => item.key), ["next"]);
  assert.equal(b.snapshot().text, "different project");
  assert.equal(b.snapshot().items.length, 0);
});
