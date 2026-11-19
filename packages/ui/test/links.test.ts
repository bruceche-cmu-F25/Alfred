import assert from "node:assert/strict";
import { test } from "node:test";
import { linkParts } from "../src/links.ts";
import { startLayout } from "../src/shell/layout.ts";

const links = (text: string) => linkParts(text).filter((part) => typeof part !== "string").map((part) => (part as { url: string }).url);

test("web addresses in text become links, and the text around them stays as written", () => {
  assert.deepEqual(linkParts("Pay the rent at https://bank.example.com/pay today"), [
    "Pay the rent at ", { url: "https://bank.example.com/pay", text: "https://bank.example.com/pay" }, " today",
  ]);
  assert.deepEqual(linkParts("no address here"), ["no address here"]);
  assert.deepEqual(linkParts(""), []);
  assert.deepEqual(linkParts("www.example.com"), [{ url: "https://www.example.com/", text: "www.example.com" }]);
  assert.deepEqual(links("two: http://a.example/x and https://b.example/y?q=1&r=2#top"), ["http://a.example/x", "https://b.example/y?q=1&r=2#top"]);
});

test("what ends the sentence is not part of the address", () => {
  assert.deepEqual(links("See https://example.com/a."), ["https://example.com/a"]);
  assert.deepEqual(links("(details: https://example.com/a)"), ["https://example.com/a"]);
  assert.deepEqual(links("https://en.wikipedia.org/wiki/Tesseract_(disambiguation)"), ["https://en.wikipedia.org/wiki/Tesseract_(disambiguation)"]);
  assert.deepEqual(links("会议链接：https://zoom.us/j/123456，记得提前五分钟。"), ["https://zoom.us/j/123456"]);
  assert.deepEqual(links("在「https://example.com/页面」里"), ["https://example.com/%E9%A1%B5%E9%9D%A2"]);
});

test("only web addresses are linked", () => {
  assert.deepEqual(links("javascript:alert(1) file:///etc/passwd mailto:a@b.co ana@www.example.com"), []);
  assert.deepEqual(links("http:// and https://"), []);
});

test("the workspace always opens with Alfred's panel closed, and keeps the sidebar as it was left", () => {
  assert.equal(startLayout(null, 1400).alfred, "closed");
  const left = startLayout(JSON.stringify({ nav: "rail", navW: 250, alfW: 500, alfred: "open", v: 2 }), 1400);
  assert.deepEqual(left, { nav: "hidden", navW: 250, alfW: 500, alfred: "closed" });
  assert.equal(startLayout("not json", 800).nav, "hidden");
  assert.equal(startLayout("not json", 1000).nav, "full");
});
