import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  FileCheckpointStore,
  type PendingCall,
  type RunCheckpoint,
} from "../src/checkpoint.js";

const UUID = "11111111-1111-4111-8111-111111111111";

function sample(over: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    runId: UUID,
    messages: [{ role: "user" as const, content: "hi" }],
    pending: [
      {
        toolCallId: "call_1",
        name: "run_browser_js",
        arguments: "{\"code\":\"x\"}",
      } satisfies PendingCall,
    ],
    browserEvalFailures: 0,
    stepsUsed: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

test("save then load round-trips", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ckpt-"));
  try {
    const store = new FileCheckpointStore(dir);
    const cp = sample();
    await store.save(cp);
    const loaded = await store.load(UUID);
    assert.deepEqual(loaded, cp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load missing run returns null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ckpt-"));
  try {
    const store = new FileCheckpointStore(dir);
    assert.equal(await store.load(UUID), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete removes file; load after delete is null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ckpt-"));
  try {
    const store = new FileCheckpointStore(dir);
    await store.save(sample());
    await store.delete(UUID);
    assert.equal(await store.load(UUID), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load of expired checkpoint deletes file and returns null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ckpt-"));
  try {
    const store = new FileCheckpointStore(dir);
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await store.save(sample({ updatedAt: expired }));
    assert.equal(await store.load(UUID), null);
    assert.equal(await store.load(UUID), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reject path-traversal runId", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ckpt-"));
  try {
    const store = new FileCheckpointStore(dir);
    await assert.rejects(() => store.save({ ...sample(), runId: "../etc/passwd" }));
    assert.equal(await store.load("../etc/passwd"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
