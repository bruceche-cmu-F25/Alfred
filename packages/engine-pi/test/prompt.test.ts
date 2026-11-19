import assert from "node:assert/strict";
import { test } from "node:test";
import { composePrompt } from "../src/index.ts";

test("the prompt says the date, then the page the user asked from (as context), then the request", () => {
  const plain = composePrompt({ today: "2026-11-18", timezone: "Asia/Shanghai", goal: "what first?" });
  assert.equal(plain, "Today is 2026-11-18 (Wednesday), timezone Asia/Shanghai.\n\nwhat first?");

  const prompt = composePrompt({
    today: "2026-11-18", timezone: "Asia/Shanghai", goal: "what first?",
    context: { view: "todo.list", title: "Todos", summary: "3 open, 1 overdue", selection: { id: "t1", title: "Hand in report" } },
  });
  assert.equal(prompt.split("\n")[1],
    "The user is looking at the Todos (todo.list) page: 3 open, 1 overdue. Selected: Hand in report (t1). This is context, not a request.");
  assert.ok(prompt.endsWith("\n\nwhat first?"));
  assert.match(composePrompt({ today: "2026-11-18", timezone: "UTC", goal: "x", context: { view: "core.inbox" } }), /looking at the core\.inbox page\. This is context/);
});
