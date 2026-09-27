import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AdmissionGate, SaturatedError } from "../src/admission.js";
import { createApp } from "../src/server.js";
import type { mmagent } from "../src/agent.js";
import { makeAgent } from "./helpers.js";

async function listen(
  agent: mmagent,
  admission: AdmissionGate,
): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp(agent, { admission });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function postComplete(base: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    signal,
  });
}

test("release is idempotent and the slot can be taken again", async () => {
  const gate = new AdmissionGate(1, 0);
  const release = await gate.acquire();
  release();
  release();
  assert.equal(gate.inflightCount, 0);
  const again = await gate.acquire();
  assert.equal(gate.inflightCount, 1);
  again();
});

test("waiters enter in FIFO order", async () => {
  const gate = new AdmissionGate(1, 2);
  const hold = await gate.acquire();
  const order: number[] = [];
  const second = gate.acquire().then((release) => {
    order.push(2);
    release();
  });
  const third = gate.acquire().then((release) => {
    order.push(3);
    release();
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, []);
  hold();
  await second;
  await third;
  assert.deepEqual(order, [2, 3]);
  assert.equal(gate.inflightCount, 0);
});

test("abort while waiting frees the queue slot", async () => {
  const gate = new AdmissionGate(1, 1);
  const hold = await gate.acquire();
  const ac = new AbortController();
  const waiting = gate.acquire(ac.signal);
  assert.equal(gate.waitingCount, 1);
  ac.abort();
  await assert.rejects(waiting, (e: Error) => e.name === "AbortError");
  assert.equal(gate.waitingCount, 0);
  const next = gate.acquire();
  assert.equal(gate.waitingCount, 1);
  hold();
  (await next)();
  assert.equal(gate.inflightCount, 0);
});

test("a full queue rejects immediately", async () => {
  const gate = new AdmissionGate(1, 0);
  const hold = await gate.acquire();
  await assert.rejects(gate.acquire(), (e: unknown) => e instanceof SaturatedError);
  hold();
});

test("POST /complete over capacity returns 429 and does not consume the model", async () => {
  const gate = new AdmissionGate(1, 0);
  const agent = makeAgent({
    delayMs: 300,
    turns: [{ content: "only-one" }, { content: "should-not-run" }],
  });
  const { base, close } = await listen(agent, gate);
  try {
    const first = postComplete(base);
    await waitFor(() => gate.inflightCount === 1);
    const second = await postComplete(base);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "1");
    assert.deepEqual(await second.json(), {
      error: "overloaded",
      detail: "too many concurrent agent runs",
    });
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    const body = (await firstRes.json()) as { content: string };
    assert.equal(body.content, "only-one");
    assert.equal(gate.inflightCount, 0);
  } finally {
    await close();
  }
});

test("a queued /complete runs after the slot frees; the one past the queue gets 429", async () => {
  const gate = new AdmissionGate(1, 1);
  const agent = makeAgent({
    delayMs: 200,
    turns: [{ content: "first" }, { content: "second" }],
  });
  const { base, close } = await listen(agent, gate);
  try {
    const first = postComplete(base);
    await waitFor(() => gate.inflightCount === 1);
    const second = postComplete(base);
    await waitFor(() => gate.waitingCount === 1);
    const third = await postComplete(base);
    assert.equal(third.status, 429);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(gate.inflightCount, 0);
    assert.equal(gate.waitingCount, 0);
  } finally {
    await close();
  }
});
