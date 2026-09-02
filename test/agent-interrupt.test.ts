import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { makeAgent, tempStore, browserArgs } from "./helpers.js";
import { ResumeError } from "../src/agent.js";
import type { Tool } from "../src/tools/types.js";
import { RunBrowserJsTool } from "../src/tools/run-browser-js.js";

function searchTool(result = "## Search Results\n\nok"): Tool {
  return {
    name: "web_search",
    description: "search",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async execute() {
      return result;
    },
  };
}

test("runWithMessages returns final outcome from scripted LLM", async () => {
  const agent = makeAgent({ turns: [{ content: "hello from script" }] });
  const outcome = await agent.runWithMessages([{ role: "user", content: "hi" }]);
  assert.equal(outcome.type, "final");
  if (outcome.type === "final") assert.equal(outcome.content, "hello from script");
});

test("run_browser_js writes checkpoint, interrupts, and does not execute code", async () => {
  const { store, dir } = await tempStore();
  try {
    const tool = new RunBrowserJsTool();
    let executed = 0;
    const wrapped: Tool = {
      ...tool,
      execution: "browser",
      async execute(args) {
        executed += 1;
        return tool.execute(args);
      },
    };
    const agent = makeAgent({
      checkpoints: store,
      tools: [wrapped],
      turns: [
        {
          tool_calls: [
            {
              id: "call_js",
              name: "run_browser_js",
              arguments: browserArgs("make red", "document.body.style.background='red'"),
            },
          ],
        },
      ],
    });
    const outcome = await agent.runWithMessages([{ role: "user", content: "red please" }]);
    assert.equal(executed, 0);
    assert.equal(outcome.type, "interrupt");
    if (outcome.type !== "interrupt") return;
    assert.ok(outcome.runId);
    assert.equal(outcome.pending.length, 1);
    assert.equal(outcome.pending[0].tool_call_id, "call_js");
    assert.equal(outcome.pending[0].name, "run_browser_js");
    assert.equal(outcome.pending[0].summary, "make red");
    assert.equal(outcome.pending[0].code, "document.body.style.background='red'");
    const cp = await store.load(outcome.runId);
    assert.ok(cp);
    assert.equal(cp.pending.length, 1);
    assert.equal(cp.pending[0].toolCallId, "call_js");
    assert.equal(cp.browserEvalFailures, 0);
    const roles = cp.messages.map((m) => m.role);
    assert.ok(roles.includes("assistant"));
    assert.ok(!cp.messages.some((m) => m.role === "tool"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty code does not interrupt and writes a tool error", async () => {
  const { store, dir } = await tempStore();
  try {
    const agent = makeAgent({
      checkpoints: store,
      turns: [
        {
          tool_calls: [
            { id: "call_empty", name: "run_browser_js", arguments: browserArgs("noop", "   ") },
          ],
        },
        { content: "could not change the page" },
      ],
    });
    const outcome = await agent.runWithMessages([{ role: "user", content: "do it" }]);
    assert.equal(outcome.type, "final");
    if (outcome.type === "final") {
      assert.equal(outcome.content, "could not change the page");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same turn: server tool runs first, then browser interrupt", async () => {
  const { store, dir } = await tempStore();
  try {
    let searched = 0;
    const agent = makeAgent({
      checkpoints: store,
      tools: [
        {
          ...searchTool("search-ok"),
          async execute() {
            searched += 1;
            return "search-ok";
          },
        },
        new RunBrowserJsTool(),
      ],
      turns: [
        {
          tool_calls: [
            { id: "call_s", name: "web_search", arguments: "{\"query\":\"q\"}" },
            {
              id: "call_js",
              name: "run_browser_js",
              arguments: browserArgs("banner", "console.log(1)"),
            },
          ],
        },
      ],
    });
    const outcome = await agent.runWithMessages([{ role: "user", content: "search then paint" }]);
    assert.equal(searched, 1);
    assert.equal(outcome.type, "interrupt");
    if (outcome.type !== "interrupt") return;
    const cp = await store.load(outcome.runId);
    assert.ok(cp);
    const toolMsgs = cp.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 1);
    assert.equal(toolMsgs[0].tool_call_id, "call_s");
    assert.equal(cp.pending.length, 1);
    assert.equal(cp.pending[0].toolCallId, "call_js");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume with ok continues to final and deletes checkpoint", async () => {
  const { store, dir } = await tempStore();
  try {
    const agent = makeAgent({
      checkpoints: store,
      turns: [
        {
          tool_calls: [
            {
              id: "call_js",
              name: "run_browser_js",
              arguments: browserArgs("red", "1+1"),
            },
          ],
        },
        { content: "done painting" },
      ],
    });
    const interrupted = await agent.runWithMessages([{ role: "user", content: "paint" }]);
    assert.equal(interrupted.type, "interrupt");
    if (interrupted.type !== "interrupt") return;
    const outcome = await agent.resume(interrupted.runId, [
      { tool_call_id: "call_js", content: "2", outcome: "ok" },
    ]);
    assert.equal(outcome.type, "final");
    if (outcome.type === "final") assert.equal(outcome.content, "done painting");
    assert.equal(await store.load(interrupted.runId), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume unknown runId throws not_found", async () => {
  const { store, dir } = await tempStore();
  try {
    const agent = makeAgent({ checkpoints: store, turns: [{ content: "x" }] });
    await assert.rejects(
      () => agent.resume("11111111-1111-4111-8111-111111111111", []),
      (e: unknown) => e instanceof ResumeError && e.status === 404,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume with no pending throws conflict", async () => {
  const { store, dir } = await tempStore();
  try {
    const runId = "22222222-2222-4222-8222-222222222222";
    await store.save({
      runId,
      messages: [{ role: "user", content: "hi" }],
      pending: [],
      browserEvalFailures: 0,
      stepsUsed: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const agent = makeAgent({ checkpoints: store, turns: [{ content: "x" }] });
    await assert.rejects(
      () =>
        agent.resume(runId, [
          { tool_call_id: "call_x", content: "n", outcome: "ok" },
        ]),
      (e: unknown) => e instanceof ResumeError && e.status === 409,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("three error outcomes then next browser call does not interrupt", async () => {
  const { store, dir } = await tempStore();
  try {
    const js = browserArgs("x", "throw new Error('boom')");
    const agent = makeAgent({
      checkpoints: store,
      maxSteps: 8,
      turns: [
        { tool_calls: [{ id: "c1", name: "run_browser_js", arguments: js }] },
        { tool_calls: [{ id: "c2", name: "run_browser_js", arguments: js }] },
        { tool_calls: [{ id: "c3", name: "run_browser_js", arguments: js }] },
        { tool_calls: [{ id: "c4", name: "run_browser_js", arguments: js }] },
        { content: "stopped after three failures" },
      ],
    });
    const r1 = await agent.runWithMessages([{ role: "user", content: "paint" }]);
    assert.equal(r1.type, "interrupt");
    if (r1.type !== "interrupt") return;

    const after = async (runId: string, id: string, n: number) => {
      const o = await agent.resume(runId, [
        { tool_call_id: id, content: `err${n}`, outcome: "error" },
      ]);
      return o;
    };

    const r2 = await after(r1.runId, "c1", 1);
    assert.equal(r2.type, "interrupt");
    if (r2.type !== "interrupt") return;
    const r3 = await after(r2.runId, "c2", 2);
    assert.equal(r3.type, "interrupt");
    if (r3.type !== "interrupt") return;
    const r4 = await after(r3.runId, "c3", 3);
    assert.equal(r4.type, "final");
    if (r4.type === "final") {
      assert.equal(r4.content, "stopped after three failures");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ok outcome resets failure count so a later error can interrupt again", async () => {
  const { store, dir } = await tempStore();
  try {
    const js = browserArgs("x", "1");
    const agent = makeAgent({
      checkpoints: store,
      turns: [
        { tool_calls: [{ id: "a", name: "run_browser_js", arguments: js }] },
        { tool_calls: [{ id: "b", name: "run_browser_js", arguments: js }] },
        { tool_calls: [{ id: "c", name: "run_browser_js", arguments: js }] },
        { content: "after reset" },
      ],
    });
    const i1 = await agent.runWithMessages([{ role: "user", content: "x" }]);
    assert.equal(i1.type, "interrupt");
    if (i1.type !== "interrupt") return;
    const i2 = await agent.resume(i1.runId, [
      { tool_call_id: "a", content: "boom", outcome: "error" },
    ]);
    assert.equal(i2.type, "interrupt");
    if (i2.type !== "interrupt") return;
    const i3 = await agent.resume(i2.runId, [
      { tool_call_id: "b", content: "ok", outcome: "ok" },
    ]);
    assert.equal(i3.type, "interrupt");
    if (i3.type !== "interrupt") return;
    const cp = await store.load(i3.runId);
    assert.equal(cp?.browserEvalFailures, 0);
    const fin = await agent.resume(i3.runId, [
      { tool_call_id: "c", content: "ok2", outcome: "ok" },
    ]);
    assert.equal(fin.type, "final");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejected outcome does not increment failures", async () => {
  const { store, dir } = await tempStore();
  try {
    const js = browserArgs("x", "1");
    const agent = makeAgent({
      checkpoints: store,
      turns: [
        { tool_calls: [{ id: "a", name: "run_browser_js", arguments: js }] },
        { tool_calls: [{ id: "b", name: "run_browser_js", arguments: js }] },
        { content: "after reject" },
      ],
    });
    const i1 = await agent.runWithMessages([{ role: "user", content: "x" }]);
    assert.equal(i1.type, "interrupt");
    if (i1.type !== "interrupt") return;
    const i2 = await agent.resume(i1.runId, [
      { tool_call_id: "a", content: "user rejected", outcome: "rejected" },
    ]);
    assert.equal(i2.type, "interrupt");
    if (i2.type !== "interrupt") return;
    assert.equal((await store.load(i2.runId))?.browserEvalFailures, 0);
    const fin = await agent.resume(i2.runId, [
      { tool_call_id: "b", content: "2", outcome: "ok" },
    ]);
    assert.equal(fin.type, "final");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
