import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { mmagent, type LlmClient } from "../src/agent.js";
import { FileCheckpointStore, type CheckpointStore } from "../src/checkpoint.js";
import type { Tool } from "../src/tools/types.js";
import { RunBrowserJsTool } from "../src/tools/run-browser-js.js";

export type ScriptTurn =
  | { content: string }
  | {
      content?: string | null;
      tool_calls: { id: string; name: string; arguments: string }[];
    };

export function scriptedClient(turns: ScriptTurn[]): LlmClient {
  let i = 0;
  return {
    chat: {
      completions: {
        async create() {
          const turn = turns[i++];
          if (!turn) throw new Error("scripted LLM has no remaining turns");
          if ("tool_calls" in turn && turn.tool_calls) {
            return {
              choices: [
                {
                  message: {
                    content: turn.content ?? null,
                    tool_calls: turn.tool_calls.map((tc) => ({
                      id: tc.id,
                      type: "function" as const,
                      function: { name: tc.name, arguments: tc.arguments },
                    })),
                  },
                },
              ],
            };
          }
          return { choices: [{ message: { content: turn.content } }] };
        },
      },
    },
  };
}

export async function tempStore(): Promise<{ store: CheckpointStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-runs-"));
  return { store: new FileCheckpointStore(dir), dir };
}

export function makeAgent(opts: {
  turns: ScriptTurn[];
  tools?: Tool[];
  maxSteps?: number;
  checkpoints?: CheckpointStore;
}): mmagent {
  return new mmagent(
    "test-model",
    opts.tools ?? [new RunBrowserJsTool()],
    opts.maxSteps ?? 10,
    undefined,
    "",
    { client: scriptedClient(opts.turns), checkpoints: opts.checkpoints },
  );
}

export function browserArgs(summary: string, code: string): string {
  return JSON.stringify({ summary, code });
}

export type ChatMessage = OpenAI.ChatCompletionMessageParam;
