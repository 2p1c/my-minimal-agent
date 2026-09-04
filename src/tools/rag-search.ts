import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { Tool } from "./types.js";

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

function formatScore(score: unknown): string {
  return typeof score === "number" && Number.isFinite(score)
    ? score.toFixed(2)
    : "n/a";
}

function formatSource(source: unknown): string {
  return typeof source === "string" && source.trim() !== ""
    ? source
    : "(unknown)";
}

function formatResults(results: unknown[], maxOutputLength: number): string {
  const blocks: string[] = [];
  let n = 0;
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.text !== "string" || rec.text.trim() === "") continue;
    n += 1;
    blocks.push(
      `### [${n}] score=${formatScore(rec.score)} | source=${formatSource(rec.source)}\n${rec.text}`,
    );
  }
  if (blocks.length === 0) return "No relevant documents found.";
  return truncate(
    "## Retrieved context\n\n" + blocks.join("\n\n"),
    maxOutputLength,
  );
}

export class RagSearchTool implements Tool {
  name = "rag_search";
  description =
    "Search the connected knowledge base for documents relevant to the query. Use for personal or domain documents (notes, projects, prior writing). Do not use for current events or general web facts; use web_search for those.";
  parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query to look up in the knowledge base.",
      },
    },
    required: ["query"],
  } as const;

  constructor(
    private searchUrl: string,
    private maxOutputLength = 8000,
  ) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query;
    if (typeof query !== "string" || query.trim() === "") {
      return `Error executing tool "rag_search": query must be a non-empty string.`;
    }
    try {
      const response = await fetch(this.searchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        return `Error executing tool "rag_search": HTTP ${response.status}`;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return `Error executing tool "rag_search": invalid JSON response`;
      }
      if (!body || typeof body !== "object" || !("results" in body)) {
        return `Error executing tool "rag_search": results must be an array`;
      }
      const results = (body as { results: unknown }).results;
      if (!Array.isArray(results)) {
        return `Error executing tool "rag_search": results must be an array`;
      }
      return formatResults(results, this.maxOutputLength);
    } catch (e) {
      return `Error executing tool "rag_search": ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
  }
}

export type ChatMessage = OpenAI.ChatCompletionMessageParam;

export async function applyRagSlash(
  messages: ChatMessage[],
  tool: Tool | undefined,
  idFactory: () => string = () => `rag_${randomUUID()}`,
): Promise<ChatMessage[]> {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return messages;
  const content = messages[lastUser].content;
  if (typeof content !== "string") return messages;
  const trimmed = content.trim();
  if (!/^\/rag(\s|$)/.test(trimmed)) return messages;

  const query = trimmed.slice("/rag".length).trim();
  const next = messages.slice();

  if (!tool) {
    if (query) next[lastUser] = { role: "user", content: query };
    return next;
  }

  const id = idFactory();
  let toolContent: string;
  if (!query) {
    toolContent = "Error: /rag requires a query.";
  } else {
    next[lastUser] = { role: "user", content: query };
    toolContent = await tool.execute({ query });
  }

  const assistant: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name: "rag_search",
          arguments: JSON.stringify({ query }),
        },
      },
    ],
  };
  const toolMsg: ChatMessage = {
    role: "tool",
    tool_call_id: id,
    content: toolContent,
  };
  next.splice(lastUser + 1, 0, assistant, toolMsg);
  return next;
}

