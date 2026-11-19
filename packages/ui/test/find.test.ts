import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPick, findItems, type FindSources } from "../src/shell/find.ts";

const went: string[] = [];
const sources: FindSources = {
  pages: [{ key: "todo.list", title: "Todos", icon: "todo" }, { key: "mail.inbox", title: "Mail", icon: "mail" }],
  commands: [{ id: "new", label: "New conversation", icon: "plus", run: () => went.push("new") }],
  conversations: [{ id: "c1", title: "What should I do first today?" }, { id: "c2", title: "Mail from Leo" }],
  onPage: (key) => went.push(`page:${key}`),
  onSelect: (id) => went.push(`conv:${id}`),
};

test("typing finds pages, commands and conversations by name, pages first", () => {
  const found = findItems("mail", sources);
  assert.deepEqual(found.map((item) => item.id), ["page:mail.inbox", "conv:c2"]);
  found[0].run();
  found[1].run();
  assert.deepEqual(went.splice(0), ["page:mail.inbox", "conv:c2"]);
  assert.deepEqual(findItems("conversation", sources).map((item) => item.kind), ["command"]);
  assert.equal(findItems("", sources).length, 5, "with no words: everything there is to go to");
});

test("in the ask bar Enter goes to a page or command named by the words, and otherwise asks Alfred", () => {
  assert.equal(defaultPick(findItems("todos", sources)), 0, "a page's name: go there");
  assert.equal(defaultPick(findItems("new conv", sources)), 0, "a command's name: run it");
  assert.equal(defaultPick(findItems("which mail needs a reply", sources)), -1, "a question matches nothing: ask");
});

test("a question asked before is asked again, not taken for a search for the old conversation", () => {
  const found = findItems("What should I do first today?", sources);
  assert.deepEqual(found.map((item) => item.id), ["conv:c1"], "the old conversation is offered");
  assert.equal(defaultPick(found), -1, "but Enter asks");
});
