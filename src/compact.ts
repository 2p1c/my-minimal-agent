import type OpenAI from "openai";

export type ChatMessage = OpenAI.ChatCompletionMessageParam;

export const RECENT_TURNS = 10;
export const SUMMARY_MAX_CHARS = 8000;
export const NOTICE_COMPACTED = "上下文已压缩。";
export const NOTICE_SKIPPED = "最近对话不足 10 轮，无需压缩。";

export const COMPACT_PROMPT = `You summarize an earlier part of a conversation so another assistant can continue.

Preserve: user goals, decisions, facts, file or tool outcomes, and unresolved tasks.
Omit: greetings, duplicated tool dumps, and chain-of-thought.
Write a concise summary in the same language as the conversation.`;

export function isCompactSlash(content: unknown): boolean {
  return typeof content === "string" && content.trim() === "/compact";
}

export function stripTrailingCompact(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role === "user" && isCompactSlash(last.content)) {
    return messages.slice(0, -1);
  }
  return messages;
}

export function splitConversation(messages: ChatMessage[]): {
  prefix: ChatMessage[];
  turns: ChatMessage[][];
} {
  const prefix: ChatMessage[] = [];
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] | undefined;
  for (const msg of messages) {
    if (msg.role === "user") {
      if (current) turns.push(current);
      current = [msg];
      continue;
    }
    if (!current) {
      prefix.push(msg);
      continue;
    }
    current.push(msg);
  }
  if (current) turns.push(current);
  return { prefix, turns };
}

export function partitionForCompact(messages: ChatMessage[]): {
  old: ChatMessage[];
  recent: ChatMessage[];
  skipped: boolean;
} {
  const { prefix, turns } = splitConversation(messages);
  if (turns.length <= RECENT_TURNS) {
    return { old: [], recent: messages, skipped: true };
  }
  const recentTurns = turns.slice(-RECENT_TURNS);
  const oldTurns = turns.slice(0, -RECENT_TURNS);
  return {
    old: [...prefix, ...oldTurns.flat()],
    recent: recentTurns.flat(),
    skipped: false,
  };
}

function contentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

export function serializeMessages(messages: ChatMessage[]): string {
  const blocks: string[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      blocks.push(`[tool ${msg.tool_call_id}] ${contentText(msg.content)}`);
      continue;
    }
    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls?.length) {
      const calls = msg.tool_calls
        .filter((c) => c.type === "function")
        .map((c) => `${c.function.name}(${c.function.arguments || ""})`)
        .join("; ");
      const text = contentText(msg.content);
      blocks.push(`[assistant tool_calls] ${calls}${text ? `\n${text}` : ""}`);
      continue;
    }
    blocks.push(`[${msg.role}] ${contentText(msg.content)}`);
  }
  return blocks.join("\n\n");
}

export function compactedMessages(summary: string, recent: ChatMessage[]): ChatMessage[] {
  let text = summary.trim() || "Earlier conversation was truncated.";
  if (text.length > SUMMARY_MAX_CHARS) {
    text = text.slice(0, SUMMARY_MAX_CHARS);
  }
  return [{ role: "system", content: `Prior conversation summary:\n${text}` }, ...recent];
}

export function compactPromptMessages(old: ChatMessage[]): ChatMessage[] {
  return [
    { role: "system", content: COMPACT_PROMPT },
    { role: "user", content: serializeMessages(old) },
  ];
}
