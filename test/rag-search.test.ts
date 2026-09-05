import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { applyRagSlash, RagSearchTool } from "../src/tools/rag-search.js";
import { createTools } from "../src/tools/index.js";
import type { Tool } from "../src/tools/types.js";
import { mmagent } from "../src/agent.js";
import { scriptedClient, tempStore, browserArgs } from "./helpers.js";
import { RunBrowserJsTool } from "../src/tools/run-browser-js.js";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("formats results as numbered markdown with score and source", async () => {
  let sent: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    sent = { url: String(url), init };
    return jsonResponse({
      results: [
        { text: "chunk-a", source: "a.md", score: 0.821 },
        { text: "chunk-b", source: "b.md", score: 0.5 },
      ],
    });
  }) as typeof fetch;

  const tool = new RagSearchTool("http://rag.test/search");
  const out = await tool.execute({ query: "architecture" });

  assert.equal(sent?.url, "http://rag.test/search");
  assert.equal(sent?.init?.method, "POST");
  assert.equal(sent?.init?.body, JSON.stringify({ query: "architecture" }));
  assert.match(out, /^## Retrieved context\n/);
  assert.match(out, /### \[1\] score=0\.82 \| source=a\.md\nchunk-a/);
  assert.match(out, /### \[2\] score=0\.50 \| source=b\.md\nchunk-b/);
});

test("empty results returns fixed not-found sentence", async () => {
  globalThis.fetch = (async () => jsonResponse({ results: [] })) as typeof fetch;
  const out = await new RagSearchTool("http://rag.test/search").execute({
    query: "zzz",
  });
  assert.equal(out, "No relevant documents found.");
});

test("skips entries without text; default source and score", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      results: [
        { source: "x.md", score: 0.9 },
        { text: "keep-me" },
        { text: "   " },
      ],
    })) as typeof fetch;
  const out = await new RagSearchTool("http://rag.test/search").execute({
    query: "q",
  });
  assert.match(out, /### \[1\] score=n\/a \| source=\(unknown\)\nkeep-me/);
  assert.doesNotMatch(out, /### \[2\]/);
});

test("empty query does not call fetch", async () => {
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return jsonResponse({ results: [] });
  }) as typeof fetch;
  const out = await new RagSearchTool("http://rag.test/search").execute({
    query: "  ",
  });
  assert.equal(called, 0);
  assert.match(out, /query must be a non-empty string/);
});

test("HTTP 500 returns error string and does not throw", async () => {
  globalThis.fetch = (async () => jsonResponse({ error: "nope" }, 500)) as typeof fetch;
  const out = await new RagSearchTool("http://rag.test/search").execute({
    query: "q",
  });
  assert.equal(out, `Error executing tool "rag_search": HTTP 500`);
});

test("invalid JSON returns error string", async () => {
  globalThis.fetch = (async () =>
    new Response("not-json", { status: 200 })) as typeof fetch;
  const out = await new RagSearchTool("http://rag.test/search").execute({
    query: "q",
  });
  assert.match(out, /invalid JSON response/);
});

test("results not an array returns error string, not the not-found sentence", async () => {
  globalThis.fetch = (async () => jsonResponse({ results: "nope" })) as typeof fetch;
  const out = await new RagSearchTool("http://rag.test/search").execute({
    query: "q",
  });
  assert.match(out, /results must be an array/);
  assert.notEqual(out, "No relevant documents found.");
});

test("truncates output to maxOutputLength", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      results: [{ text: "abcdefghij", source: "a.md", score: 1 }],
    })) as typeof fetch;
  const out = await new RagSearchTool("http://rag.test/search", 20).execute({
    query: "q",
  });
  assert.equal(out.length, 23); // 20 chars + "..."
  assert.ok(out.endsWith("..."));
});

test("network failure returns error string", async () => {
  globalThis.fetch = (async () => {
    throw new Error("timeout");
  }) as typeof fetch;
  const out = await new RagSearchTool("http://rag.test/search").execute({
    query: "q",
  });
  assert.equal(out, `Error executing tool "rag_search": timeout`);
});

function fakeRagTool(execute: Tool["execute"]): Tool {
  return {
    name: "rag_search",
    description: "test",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute,
  };
}

test("applyRagSlash with query executes and injects tool messages", async () => {
  const tool = fakeRagTool(async (args) => `HIT:${args.query}`);
  const out = await applyRagSlash(
    [
      { role: "assistant", content: "hi" },
      { role: "user", content: "  /rag 朱工的项目架构  " },
    ],
    tool,
    () => "rag_fixed",
  );
  assert.equal(out.length, 4);
  assert.equal(out[1].role, "user");
  if (out[1].role === "user") assert.equal(out[1].content, "朱工的项目架构");
  assert.equal(out[2].role, "assistant");
  if (out[2].role === "assistant" && "tool_calls" in out[2]) {
    assert.equal(out[2].content, null);
    const tc = out[2].tool_calls?.[0];
    assert.equal(tc?.id, "rag_fixed");
    assert.equal(tc?.type, "function");
    if (tc?.type === "function") {
      assert.equal(tc.function.name, "rag_search");
      assert.equal(
        tc.function.arguments,
        JSON.stringify({ query: "朱工的项目架构" }),
      );
    }
  }
  assert.equal(out[3].role, "tool");
  if (out[3].role === "tool") {
    assert.equal(out[3].tool_call_id, "rag_fixed");
    assert.equal(out[3].content, "HIT:朱工的项目架构");
  }
});

test("applyRagSlash without query does not execute and keeps user text", async () => {
  let called = 0;
  const tool = fakeRagTool(async () => {
    called += 1;
    return "nope";
  });
  const out = await applyRagSlash(
    [{ role: "user", content: "/rag" }],
    tool,
    () => "rag_empty",
  );
  assert.equal(called, 0);
  assert.equal(out[0].role, "user");
  if (out[0].role === "user") assert.equal(out[0].content, "/rag");
  assert.equal(out[2].role, "tool");
  if (out[2].role === "tool") {
    assert.equal(out[2].content, "Error: /rag requires a query.");
  }
});

test("applyRagSlash without tool strips prefix only", async () => {
  const out = await applyRagSlash(
    [{ role: "user", content: "/rag foo" }],
    undefined,
  );
  assert.equal(out.length, 1);
  if (out[0].role === "user") assert.equal(out[0].content, "foo");
});

test("applyRagSlash ignores /RAG and /ragsomething and non-last user", async () => {
  const tool = fakeRagTool(async () => "HIT");
  const upper = await applyRagSlash(
    [{ role: "user", content: "/RAG foo" }],
    tool,
  );
  assert.equal(upper.length, 1);
  const glued = await applyRagSlash(
    [{ role: "user", content: "/ragsomething" }],
    tool,
  );
  assert.equal(glued.length, 1);
  const historic = await applyRagSlash(
    [
      { role: "user", content: "/rag old" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "plain" },
    ],
    tool,
  );
  assert.equal(historic.length, 3);
  if (historic[0].role === "user") assert.equal(historic[0].content, "/rag old");
});

test("applyRagSlash no-ops when there is no user message", async () => {
  const msgs = [{ role: "assistant" as const, content: "x" }];
  const out = await applyRagSlash(msgs, fakeRagTool(async () => "HIT"));
  assert.equal(out, msgs);
});

test("createTools omits rag_search when RAG_SEARCH_URL is unset", () => {
  const prev = process.env.RAG_SEARCH_URL;
  delete process.env.RAG_SEARCH_URL;
  try {
    assert.equal(
      createTools().some((t) => t.name === "rag_search"),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.RAG_SEARCH_URL;
    else process.env.RAG_SEARCH_URL = prev;
  }
});

test("createTools registers rag_search when RAG_SEARCH_URL is set", () => {
  const prev = process.env.RAG_SEARCH_URL;
  process.env.RAG_SEARCH_URL = "http://rag.test/search";
  try {
    const names = createTools().map((t) => t.name);
    assert.ok(names.includes("rag_search"));
  } finally {
    if (prev === undefined) delete process.env.RAG_SEARCH_URL;
    else process.env.RAG_SEARCH_URL = prev;
  }
});

test("runWithMessages /rag injects tool result before first LLM call", async () => {
  const captured: unknown[][] = [];
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return jsonResponse({
      results: [{ text: "from-kb", source: "kb.md", score: 0.9 }],
    });
  }) as typeof fetch;

  const tool = new RagSearchTool("http://rag.test/search");
  const base = scriptedClient([{ content: "based on kb" }]);
  const agent = new mmagent("test-model", [tool], 10, undefined, "", {
    client: {
      chat: {
        completions: {
          async create(body) {
            captured.push(body.messages as unknown[]);
            return base.chat.completions.create(body);
          },
        },
      },
    },
  });

  const outcome = await agent.runWithMessages([
    { role: "user", content: "/rag foo" },
  ]);
  assert.equal(outcome.type, "final");
  if (outcome.type === "final") assert.equal(outcome.content, "based on kb");
  assert.equal(fetched, 1);
  assert.equal(captured.length, 1);
  const roles = captured[0].map((m) => (m as { role: string }).role);
  assert.ok(roles.includes("tool"));
  const user = captured[0].find((m) => (m as { role: string }).role === "user") as {
    content: string;
  };
  assert.equal(user.content, "foo");
});

test("resume does not re-expand /rag in checkpoint messages", async () => {
  const { store, dir } = await tempStore();
  try {
    const runId = randomUUID();
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return jsonResponse({ results: [{ text: "nope", source: "x", score: 1 }] });
    }) as typeof fetch;

    const rag = new RagSearchTool("http://rag.test/search");
    const browser = new RunBrowserJsTool();
    const base = scriptedClient([{ content: "resumed" }]);
    const agent = new mmagent("test-model", [rag, browser], 10, undefined, "", {
      checkpoints: store,
      client: {
        chat: {
          completions: {
            async create(body) {
              return base.chat.completions.create(body);
            },
          },
        },
      },
    });

    const now = new Date().toISOString();
    await store.save({
      runId,
      messages: [
        { role: "user", content: "/rag foo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_js",
              type: "function",
              function: {
                name: "run_browser_js",
                arguments: browserArgs("x", "1"),
              },
            },
          ],
        },
      ],
      pending: [
        {
          toolCallId: "call_js",
          name: "run_browser_js",
          arguments: browserArgs("x", "1"),
        },
      ],
      browserEvalFailures: 0,
      stepsUsed: 1,
      createdAt: now,
      updatedAt: now,
    });

    const outcome = await agent.resume(runId, [
      { tool_call_id: "call_js", content: "ok", outcome: "ok" },
    ]);
    assert.equal(outcome.type, "final");
    assert.equal(fetched, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
