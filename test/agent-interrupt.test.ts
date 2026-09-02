import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAgent } from "./helpers.js";

test("runWithMessages returns final outcome from scripted LLM", async () => {
  const agent = makeAgent({ turns: [{ content: "hello from script" }] });
  const outcome = await agent.runWithMessages([{ role: "user", content: "hi" }]);
  assert.equal(outcome.type, "final");
  if (outcome.type === "final") assert.equal(outcome.content, "hello from script");
});
