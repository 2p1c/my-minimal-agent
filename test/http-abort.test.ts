import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/server.js";
import { makeAgent } from "./helpers.js";
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

test("POST /complete/stream client abort does not emit done", async () => {
  const agent = makeAgent({
    delayMs: 300,
    turns: [{ content: "should not stream this" }],
  });
  const { base, close } = await listen(agent);
  try {
    const ac = new AbortController();
    const res = await fetch(`${base}/complete/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body?.getReader();
    assert.ok(reader);
    await new Promise((r) => setTimeout(r, 40));
    ac.abort();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      // 客户端 abort 会让 reader 抛错
    }
    assert.equal(buf.includes("[DONE]"), false);
    assert.equal(buf.includes('"done":true'), false);
  } finally {
    await close();
  }
});
