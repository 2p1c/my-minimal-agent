import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { mmagent, type LlmClient } from "../src/agent.js";
import { createApp } from "../src/server.js";
import type { Tool } from "../src/tools/types.js";

function searchTool(onExecute: () => void): Tool {
  return {
    name: "web_search",
    description: "search",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async execute(args) {
      onExecute();
      return `found ${String(args.query)}`;
    },
  };
}

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

test("split tool-call deltas run only after the arguments are complete", async () => {
  const seen: string[] = [];
  let calls = 0;
  const client: LlmClient = {
    chat: {
      completions: {
        async create() {
          calls += 1;
          if (calls === 1) {
            return (async function* () {
              yield { content: "looking" };
              yield { toolCallDeltas: [{ index: 0, id: "call_1", name: "web_search" }] };
              yield { toolCallDeltas: [{ index: 0, arguments: '{"query":' }] };
              yield { toolCallDeltas: [{ index: 0, arguments: '"cats"}' }] };
            })();
          }
          return (async function* () {
            yield { content: "found" };
          })();
        },
      },
    },
  };
  const agent = new mmagent("test-model", [searchTool(() => seen.push("tool"))], 10, undefined, "", {
    client,
  });
  const outcome = await agent.runWithMessages(
    [{ role: "user", content: "cats" }],
    undefined,
    "",
    undefined,
    (text) => seen.push(`delta:${text}`),
  );
  assert.deepEqual(seen, ["delta:looking", "tool", "delta:found"]);
  assert.equal(outcome.type, "final");
  if (outcome.type === "final") assert.equal(outcome.content, "found");
});

test("POST /complete/stream writes the first delta before the model finishes", async () => {
  const client: LlmClient = {
    chat: {
      completions: {
        async create() {
          return (async function* () {
            yield { content: "Hello" };
            await new Promise((r) => setTimeout(r, 400));
            yield {
              content: " world",
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            };
          })();
        },
      },
    },
  };
  const agent = new mmagent("test-model", [], 10, undefined, "", { client });
  const { base, close } = await listen(agent);
  try {
    const started = performance.now();
    const res = await fetch(`${base}/complete/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const reader = res.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let buf = "";
    while (!buf.includes('{"delta":"Hello"}')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buf += decoder.decode(chunk.value, { stream: true });
    }
    const firstMs = performance.now() - started;
    assert.ok(firstMs < 250, `first delta took ${firstMs}ms`);
    assert.equal(buf.includes("world"), false);

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(buf, /\{"delta":" world"\}/);
    assert.match(buf, /"content":"Hello world"/);
    assert.match(buf, /"total_tokens":3/);
  } finally {
    await close();
  }
});
