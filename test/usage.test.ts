import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { addUsage, emptyUsage, readUsage } from "../src/agent.js";
import { createApp } from "../src/server.js";
import { browserArgs, makeAgent, tempStore } from "./helpers.js";
import type { mmagent } from "../src/agent.js";

async function listen(agent: mmagent): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp(agent);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test("readUsage treats missing usage as zeros", () => {
  assert.deepEqual(readUsage({}), emptyUsage());
  assert.deepEqual(readUsage({ usage: null }), emptyUsage());
});

test("addUsage sums each field", () => {
  assert.deepEqual(
    addUsage(
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    ),
    { prompt_tokens: 13, completion_tokens: 6, total_tokens: 19 },
  );
});

test("runWithMessages sums usage across LLM calls in one run", async () => {
  const agent = makeAgent({
    tools: [
      {
        name: "web_search",
        description: "search",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        async execute() {
          return "ok";
        },
      },
    ],
    turns: [
      {
        tool_calls: [
          { id: "c1", name: "web_search", arguments: JSON.stringify({ query: "q" }) },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      {
        content: "answer",
        usage: { prompt_tokens: 140, completion_tokens: 10, total_tokens: 150 },
      },
    ],
  });
  const outcome = await agent.runWithMessages([{ role: "user", content: "hi" }]);
  assert.equal(outcome.type, "final");
  if (outcome.type !== "final") return;
  assert.deepEqual(outcome.usage, {
    prompt_tokens: 240,
    completion_tokens: 30,
    total_tokens: 270,
  });
});

test("POST /complete JSON includes this run's usage", async () => {
  const agent = makeAgent({
    turns: [
      {
        content: "hello",
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
      },
    ],
  });
  const { base, close } = await listen(agent);
  try {
    const res = await fetch(`${base}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      role: "assistant",
      content: "hello",
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    });
  } finally {
    await close();
  }
});

test("interrupt and resume each report only that request's usage", async () => {
  const { store, dir } = await tempStore();
  try {
    const agent = makeAgent({
      checkpoints: store,
      turns: [
        {
          tool_calls: [
            { id: "call_js", name: "run_browser_code", arguments: browserArgs("x", "1") },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 },
        },
        {
          content: "all done",
          usage: { prompt_tokens: 70, completion_tokens: 6, total_tokens: 76 },
        },
      ],
    });
    const { base, close } = await listen(agent);
    try {
      const started = await fetch(`${base}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
      });
      const interrupted = (await started.json()) as {
        interrupt: boolean;
        run_id: string;
        usage: { total_tokens: number };
      };
      assert.equal(interrupted.interrupt, true);
      assert.deepEqual(interrupted.usage, {
        prompt_tokens: 50,
        completion_tokens: 8,
        total_tokens: 58,
      });

      const resumed = await fetch(`${base}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: interrupted.run_id,
          results: [{ tool_call_id: "call_js", content: "1", outcome: "ok" }],
        }),
      });
      assert.deepEqual(await resumed.json(), {
        role: "assistant",
        content: "all done",
        usage: { prompt_tokens: 70, completion_tokens: 6, total_tokens: 76 },
      });
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /complete/stream done event includes usage", async () => {
  const agent = makeAgent({
    turns: [
      {
        content: "streamed",
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ],
  });
  const { base, close } = await listen(agent);
  try {
    const res = await fetch(`${base}/complete/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await res.text();
    assert.match(text, /"done":true/);
    assert.match(text, /"prompt_tokens":3/);
    assert.match(text, /"total_tokens":5/);
  } finally {
    await close();
  }
});
