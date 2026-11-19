import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "../src/i18n/en.ts";
import { detectLocale, translate } from "../src/i18n/dict.ts";
import { zh } from "../src/i18n/zh.ts";
import { welcomeLines } from "../src/welcome.ts";

test("both languages have every key, and none is empty", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) assert.ok(value.trim(), `${key} is empty`);
});

test("placeholders and English plurals", () => {
  assert.equal(translate("en", "page.inbox.waiting", { n: 1 }), "1 thing needs you");
  assert.equal(translate("en", "page.inbox.waiting", { n: 3 }), "3 things need you");
  assert.equal(translate("zh", "page.inbox.waiting", { n: 3 }), "3 件等你决定");
  assert.equal(translate("en", "inbox.steps", { n: 1 }), "Accepting does this");
  assert.equal(translate("en", "inbox.steps", { n: 2 }), "Accepting does these 2 things");
  assert.equal(translate("en", "nav.archive", { title: "Trip" }), "Archive “Trip”");
});

test("the language follows the system until the user has chosen", () => {
  assert.equal(detectLocale("zh-CN"), "zh");
  assert.equal(detectLocale("zh-Hant-TW"), "zh");
  assert.equal(detectLocale("en-GB"), "en");
  assert.equal(detectLocale(undefined), "en");
});

test("the welcome is written from the digest, in either language", () => {
  const digest = { since: "", awayMs: 25 * 60_000, runs: { completed: 2, failed: 0, interrupted: 0, goals: [] }, changes: {}, waiting: 1 };
  assert.deepEqual(welcomeLines(digest, "Bruce", "en"), { greeting: "Welcome back, Bruce.", summary: "You were away for 25 minutes: finished 2 things, 1 thing waits for you." });
  assert.deepEqual(welcomeLines(digest, null, "zh"), { greeting: "欢迎回来。", summary: "你离开了 25 分钟：办完了 2 件事，有 1 件等你看。" });
});
