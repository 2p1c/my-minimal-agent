import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type OpenAI from "openai";
import {
  compactedMessages,
  isCompactSlash,
  partitionForCompact,
  serializeMessages,
  splitConversation,
  stripTrailingCompact,
  NOTICE_COMPACTED,
  NOTICE_SKIPPED,
  RECENT_TURNS,
  SUMMARY_MAX_CHARS,
} from "../src/compact.js";
import { createApp } from "../src/server.js";
import { mmagent } from "../src/agent.js";
import { makeAgent } from "./helpers.js";

type ChatMessage = OpenAI.ChatCompletionMessageParam;

function user(content: string): ChatMessage {
  return { role: "user", content };
}

function assistant(content: string): ChatMessage {
  return { role: "assistant", content };
}

function toolCall(id: string, name: string, args: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: args },
      },
    ],
  };
}

function toolResult(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

function nTurns(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(user(`u${i}`), assistant(`a${i}`));
  }
  return out;
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

test("isCompactSlash matches exact /compact after trim", () => {
  assert.equal(isCompactSlash("/compact"), true);
  assert.equal(isCompactSlash("  /compact  "), true);
  assert.equal(isCompactSlash("/compact foo"), false);
  assert.equal(isCompactSlash("/compacted"), false);
  assert.equal(isCompactSlash("/rag"), false);
  assert.equal(isCompactSlash(null), false);
});

test("splitConversation groups from each user; prefix is leading non-user", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "old summary" },
    user("u1"),
    assistant("a1"),
    toolCall("c1", "web_search", "{\"q\":\"1\"}"),
    toolResult("c1", "result-1"),
    user("u2"),
    assistant("a2"),
  ];
  const { prefix, turns } = splitConversation(messages);
  assert.equal(prefix.length, 1);
  if (prefix[0].role === "system") assert.equal(prefix[0].content, "old summary");
  assert.equal(turns.length, 2);
  assert.equal(turns[0].length, 4);
  assert.equal(turns[1].length, 2);
});

test("partitionForCompact keeps last 10 user turns; old includes tools", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "prev" },
    ...nTurns(12),
  ];
  const { old, recent, skipped } = partitionForCompact(messages);
  assert.equal(skipped, false);
  assert.equal(recent.length, 20);
  if (recent[0].role === "user") assert.equal(recent[0].content, "u3");
  const serialized = serializeMessages(old);
  assert.match(serialized, /prev/);
  assert.match(serialized, /\[user\] u1/);
  assert.match(serialized, /\[user\] u2/);
  assert.doesNotMatch(serialized, /\[user\] u3/);
});

test("partitionForCompact skips when 10 or fewer user turns", () => {
  const { skipped, old, recent } = partitionForCompact(nTurns(10));
  assert.equal(skipped, true);
  assert.equal(old.length, 0);
  assert.equal(recent.length, 20);
});

test("tool results in old appear in the summarizer payload", () => {
  const messages: ChatMessage[] = [
    user("old-q"),
    toolCall("c1", "web_search", "{\"query\":\"q\"}"),
    toolResult("c1", "tool-secret-hit"),
    assistant("old-a"),
    ...nTurns(10),
  ];
  const { old, skipped } = partitionForCompact(messages);
  assert.equal(skipped, false);
  const serialized = serializeMessages(old);
  assert.match(serialized, /tool-secret-hit/);
  assert.match(serialized, /web_search/);
});

test("stripTrailingCompact drops only a final /compact user message", () => {
  const kept = nTurns(2);
  assert.deepEqual(stripTrailingCompact([...kept, user("/compact")]), kept);
  assert.deepEqual(stripTrailingCompact(kept), kept);
});

test("compactedMessages puts a system summary in front of recent", () => {
  const recent = nTurns(1);
  const out = compactedMessages("hello summary", recent);
  assert.equal(out.length, 3);
  assert.equal(out[0].role, "system");
  if (out[0].role === "system") {
    assert.match(String(out[0].content), /hello summary/);
  }
  assert.equal(out[1].role, "user");
});

test("compactedMessages truncates long summaries", () => {
  const summary = "x".repeat(SUMMARY_MAX_CHARS + 50);
  const out = compactedMessages(summary, []);
  if (out[0].role === "system") {
    assert.equal(String(out[0].content).length < summary.length + 40, true);
    assert.ok(String(out[0].content).includes("x".repeat(32)));
  }
});

test("mmagent.compact skips LLM when too few turns", async () => {
  const agent = makeAgent({
    turns: [{ content: "should-not-run" }],
  });
  const result = await agent.compact([...nTurns(3), user("/compact")]);
  assert.equal(result.skipped, true);
  assert.equal(result.notice, NOTICE_SKIPPED);
  assert.deepEqual(result.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(result.compacted.length, 6);
});

test("mmagent.compact calls LLM once without tools and keeps last 10 turns", async () => {
  let toolsSent: unknown = "unset";
  let callCount = 0;
  const agent = new mmagent("test-model", [], 10, undefined, "", {
    client: {
      chat: {
        completions: {
          async create(body) {
            callCount += 1;
            toolsSent = body.tools;
            return {
              choices: [{ message: { content: "SUM" } }],
              usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
            };
          },
        },
      },
    },
  });

  const messages = [...nTurns(11), user("/compact")];
  const result = await agent.compact(messages);
  assert.equal(callCount, 1);
  assert.equal(result.skipped, false);
  assert.equal(result.notice, NOTICE_COMPACTED);
  assert.equal(toolsSent, undefined);
  assert.deepEqual(result.usage, { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
  assert.equal(result.compacted[0].role, "system");
  if (result.compacted[0].role === "system") {
    assert.match(String(result.compacted[0].content), /SUM/);
  }
  assert.equal(result.compacted.length, 1 + RECENT_TURNS * 2);
  if (result.compacted[1].role === "user") assert.equal(result.compacted[1].content, "u2");
});

test("POST /compact returns compacted JSON", async () => {
  const agent = makeAgent({
    turns: [
      {
        content: "brief",
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      },
    ],
  });
  const { base, close } = await listen(agent);
  try {
    const res = await fetch(`${base}/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [...nTurns(11), { role: "user", content: "/compact" }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      skipped: boolean;
      notice: string;
      compacted: ChatMessage[];
      usage: { total_tokens: number };
    };
    assert.equal(body.skipped, false);
    assert.equal(body.notice, NOTICE_COMPACTED);
    assert.equal(body.compacted[0].role, "system");
    assert.equal(body.usage.total_tokens, 5);
  } finally {
    await close();
  }
});
