import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/server.js";
import { makeAgent, tempStore, browserArgs } from "./helpers.js";
import type { CheckpointStore } from "../src/checkpoint.js";
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

test("POST /complete returns interrupt JSON and does not execute browser JS", async () => {
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
              arguments: browserArgs("red", "document.body.style.background='red'"),
            },
          ],
        },
      ],
    });
    const { base, close } = await listen(agent);
    try {
      const res = await fetch(`${base}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "red" }] }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        interrupt: boolean;
        run_id: string;
        pending: { tool_call_id: string; summary: string; code: string }[];
      };
      assert.equal(body.interrupt, true);
      assert.ok(body.run_id);
      assert.equal(body.pending[0].summary, "red");
      assert.equal(body.pending[0].code, "document.body.style.background='red'");
      assert.ok(await store.load(body.run_id));
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /complete/stream emits event interrupt then ends without done", async () => {
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
              arguments: browserArgs("x", "1"),
            },
          ],
        },
      ],
    });
    const { base, close } = await listen(agent);
    try {
      const res = await fetch(`${base}/complete/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
      });
      const text = await res.text();
      assert.match(text, /event: interrupt/);
      assert.doesNotMatch(text, /\[DONE\]/);
      assert.doesNotMatch(text, /"done":true/);
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /resume unknown run is 404; no pending is 409", async () => {
  const { store, dir } = await tempStore();
  try {
    const agent = makeAgent({ checkpoints: store, turns: [{ content: "x" }] });
    const { base, close } = await listen(agent);
    try {
      const missing = await fetch(`${base}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: "11111111-1111-4111-8111-111111111111",
          results: [],
        }),
      });
      assert.equal(missing.status, 404);

      const runId = "33333333-3333-4333-8333-333333333333";
      await store.save({
        runId,
        messages: [{ role: "user", content: "hi" }],
        pending: [],
        browserEvalFailures: 0,
        stepsUsed: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const empty = await fetch(`${base}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: runId,
          results: [{ tool_call_id: "z", content: "n", outcome: "ok" }],
        }),
      });
      assert.equal(empty.status, 409);
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /resume with ok returns final assistant and deletes snapshot", async () => {
  const { store, dir } = await tempStore();
  try {
    const agent = makeAgent({
      checkpoints: store,
      turns: [
        {
          tool_calls: [
            { id: "call_js", name: "run_browser_js", arguments: browserArgs("x", "1") },
          ],
        },
        { content: "all done" },
      ],
    });
    const { base, close } = await listen(agent);
    try {
      const started = await fetch(`${base}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
      });
      const interrupted = (await started.json()) as { run_id: string };
      const resumed = await fetch(`${base}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: interrupted.run_id,
          results: [{ tool_call_id: "call_js", content: "1", outcome: "ok" }],
        }),
      });
      assert.equal(resumed.status, 200);
      assert.deepEqual(await resumed.json(), { role: "assistant", content: "all done" });
      assert.equal(await store.load(interrupted.run_id), null);
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /resume/stream returns SSE final without interrupt event", async () => {
  const { store, dir } = await tempStore();
  try {
    const agent = makeAgent({
      checkpoints: store,
      turns: [
        {
          tool_calls: [
            { id: "call_js", name: "run_browser_js", arguments: browserArgs("x", "1") },
          ],
        },
        { content: "streamed done" },
      ],
    });
    const { base, close } = await listen(agent);
    try {
      const started = await fetch(`${base}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
      });
      const interrupted = (await started.json()) as { run_id: string };
      const resumed = await fetch(`${base}/resume/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: interrupted.run_id,
          results: [{ tool_call_id: "call_js", content: "1", outcome: "ok" }],
        }),
      });
      const text = await resumed.text();
      assert.match(text, /streamed done/);
      assert.match(text, /\[DONE\]/);
      assert.doesNotMatch(text, /event: interrupt/);
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkpoint save failure yields 500 and no interrupt", async () => {
  const { dir } = await tempStore();
  try {
    const failing: CheckpointStore = {
      async save() {
        throw new Error("disk full");
      },
      async load() {
        return null;
      },
      async delete() {},
    };
    const agent = makeAgent({
      checkpoints: failing,
      turns: [
        {
          tool_calls: [
            { id: "call_js", name: "run_browser_js", arguments: browserArgs("x", "1") },
          ],
        },
      ],
    });
    const { base, close } = await listen(agent);
    try {
      const res = await fetch(`${base}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
      });
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "internal");
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
