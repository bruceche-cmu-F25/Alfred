import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { change, countPatch } from "../src/changing.ts";

test("a change shows its diff and counts its lines; a link out of the project is outside", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "alfred-change-")));
  const root = join(base, "shop");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(base, "elsewhere"));
  writeFileSync(join(root, "src", "cart.ts"), "export const total = 0;\nexport const items = [];\n");
  symlinkSync(join(base, "elsewhere"), join(root, "out"));
  const places = { root, cwd: base };

  const edit = change("edit", { path: "src/cart.ts", edits: [{ oldText: "total = 0", newText: "total = sum(items)" }] }, places);
  assert.equal(edit.shown, join("src", "cart.ts"));
  assert.equal(edit.inProject, true);
  assert.equal(edit.created, false);
  assert.deepEqual([edit.added, edit.removed], [1, 1]);
  assert.match(edit.patch!, /^-export const total = 0;$/m);
  assert.match(edit.patch!, /^\+export const total = sum\(items\);$/m);

  const fresh = change("write", { path: "src/new.ts", content: "a\nb\nc\n" }, places);
  assert.equal(fresh.created, true);
  assert.deepEqual([fresh.added, fresh.removed], [3, 0]);

  const missing = change("edit", { path: "src/cart.ts", edits: [{ oldText: "not there", newText: "x" }] }, places);
  assert.equal(missing.patch, null, "no diff when the text is not found");

  const linked = change("write", { path: "out/x.txt", content: "x" }, places);
  assert.equal(linked.inProject, false);
  assert.equal(linked.shown, join(base, "elsewhere", "x.txt"));
  assert.equal(change("write", { path: "../shop-other/x.txt", content: "x" }, places).inProject, false);
  assert.equal(change("write", { path: "x.txt", content: "x" }, { root: null, cwd: base }).inProject, false);
});

test("counting a patch skips its file headers", () => {
  assert.deepEqual(countPatch("--- a\n+++ b\n@@ -1 +1,2 @@\n-x\n+y\n+z\n\\ No newline at end of file"), { added: 2, removed: 1 });
});
