import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { mmagent, type LlmClient } from "../src/agent.js";
import { scriptedClient, tempStore, browserArgs } from "./helpers.js";
import type { Tool } from "../src/tools/types.js";
import { RunBrowserJsTool } from "../src/tools/run-browser-js.js";

function searchTool(): Tool {
  return {
    name: "web_search",
    description: "search",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async execute() {
      return "search-ok";
    },
  };
}

function abortableHang(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

test("aborted signal before loop does not call LLM", async () => {
  let calls = 0;
  const inner = scriptedClient([{ content: "should not run" }]);
  const client: LlmClient = {
    chat: {
      completions: {
        async create(body, options) {
          calls += 1;
          return inner.chat.completions.create(body, options);
        },
      },
    },
  };
  const ac = new AbortController();
  ac.abort();
  const agent = new mmagent("test-model", [], 10, undefined, "", { client });
  const outcome = await agent.runWithMessages(
    [{ role: "user", content: "hi" }],
    undefined,
    "",
    ac.signal,
  );
  assert.equal(outcome.type, "cancelled");
  assert.equal(calls, 0);
});

test("abort between tool result and next LLM skips the second completion", async () => {
  let calls = 0;
  const ac = new AbortController();
  const inner = scriptedClient([
    {
      tool_calls: [{ id: "s", name: "web_search", arguments: '{"query":"q"}' }],
    },
    { content: "should not appear" },
  ]);
  const client: LlmClient = {
    chat: {
      completions: {
        async create(body, options) {
          const n = calls;
          calls += 1;
          if (n === 1) await abortableHang(options?.signal);
          return inner.chat.completions.create(body, options);
        },
      },
    },
  };
  const agent = new mmagent("test-model", [searchTool()], 10, undefined, "", { client });
  const pending = agent.runWithMessages(
    [{ role: "user", content: "search" }],
    undefined,
    "",
    ac.signal,
  );
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  const outcome = await pending;
  assert.equal(outcome.type, "cancelled");
  assert.equal(calls, 2);
});

test("abort during resume deletes checkpoint and releases lock", async () => {
  const { store, dir } = await tempStore();
  try {
    const ac = new AbortController();
    let calls = 0;
    const inner = scriptedClient([
      {
        tool_calls: [
          {
            id: "call_js",
            name: "run_browser_code",
            arguments: browserArgs("red", "1+1"),
          },
        ],
      },
      { content: "should not" },
    ]);
    const client: LlmClient = {
      chat: {
        completions: {
          async create(body, options) {
            const n = calls;
            calls += 1;
            if (n >= 1) await abortableHang(options?.signal);
            return inner.chat.completions.create(body, options);
          },
        },
      },
    };
    const agent = new mmagent("test-model", [new RunBrowserJsTool()], 10, undefined, "", {
      client,
      checkpoints: store,
    });
    const interrupted = await agent.runWithMessages([{ role: "user", content: "paint" }]);
    assert.equal(interrupted.type, "interrupt");
    if (interrupted.type !== "interrupt") return;
    const runId = interrupted.runId;
    assert.ok(await store.load(runId));

    const pending = agent.resume(
      runId,
      [{ tool_call_id: "call_js", content: "2", outcome: "ok" }],
      undefined,
      ac.signal,
    );
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const outcome = await pending;
    assert.equal(outcome.type, "cancelled");
    assert.equal(await store.load(runId), null);

    await assert.rejects(
      () => agent.resume(runId, [{ tool_call_id: "call_js", content: "2", outcome: "ok" }]),
      (e: unknown) => e instanceof Error && e.name === "ResumeError",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
