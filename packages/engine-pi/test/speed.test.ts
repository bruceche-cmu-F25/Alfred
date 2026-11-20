import assert from "node:assert/strict";
import { test } from "node:test";
import { fasterPayload } from "../src/speed.ts";

test("a fast turn asks each provider its own way, and leaves other models' requests as they were", () => {
  const body = { model: "x", stream: true };
  assert.deepEqual(fasterPayload(body, { provider: "anthropic", id: "claude-opus-5-5" }), { ...body, speed: "fast" });
  assert.deepEqual(fasterPayload(body, { provider: "anthropic", id: "claude-fable-5-2" }), { ...body, speed: "fast" });
  assert.deepEqual(fasterPayload(body, { provider: "openai", id: "gpt-5.2" }), { ...body, service_tier: "priority" });
  assert.equal(fasterPayload(body, { provider: "anthropic", id: "claude-sonnet-5-5" }), body, "no fast mode there");
  assert.equal(fasterPayload(body, { provider: "openai-codex", id: "gpt-5.2" }), body, "a subscription is not asked");
  assert.equal(fasterPayload(body, { provider: "google", id: "gemini-3-pro" }), body);
});
