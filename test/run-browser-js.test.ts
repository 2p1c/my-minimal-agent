import assert from "node:assert/strict";
import { test } from "node:test";
import { RunBrowserJsTool } from "../src/tools/run-browser-js.js";

test("run_browser_js is marked browser and execute does not run code", async () => {
  const tool = new RunBrowserJsTool();
  assert.equal(tool.name, "run_browser_js");
  assert.equal(tool.execution, "browser");
  assert.deepEqual(tool.parameters.required, ["summary", "code"]);

  const result = await tool.execute({
    summary: "turn the page red",
    code: "document.body.style.background = 'red'; throw new Error('should not run');",
  });
  assert.equal(typeof result, "string");
  assert.match(result, /cannot execute on the server/i);
  assert.doesNotMatch(result, /should not run/);
});
