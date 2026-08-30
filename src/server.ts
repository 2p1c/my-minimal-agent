// 副作用导入：把 .env 里的环境变量读进 process.env。
import "dotenv/config";
// Express —— Node 上最常用的 HTTP 框架。
import express from "express";
import type { Request, Response } from "express";

import { mmagent } from "./agent.js";
import { createTools } from "./tools/index.js";

// 监听端口：可通过 PORT 环境变量覆盖，默认 8001（与 AGENT_INTEGRATION.md 对齐）。
const PORT = Number(process.env.PORT) || 8001;

// 从环境变量读取模型名；缺失则启动失败。
const model = process.env.MODEL;
if (!model) {
  console.error("MODEL environment variable is not set.");
  process.exit(1);
}

// 工具列表：统一通过 Tool Registry 获取，和 CLI 入口保持一致。
const tools = createTools();

// 全局共享一个 Agent 实例，底层 OpenAI client 也会复用 HTTP 连接。
const agent = new mmagent(model, tools, undefined, process.env.OPENAI_BASE_URL);

const app = express();
// JSON body 解析：默认上限 100kb，对长对话可能偏紧；按需放大。
app.use(express.json({ limit: "1mb" }));

// --- 工具函数 ---

// SSE 流式渲染时每个 delta 的 Unicode 码点数。8 左右能给出打字机感，又不会让事件数爆炸。
const DELTA_CHUNK_SIZE = 8;

// 把 OpenAI SDK 抛的错（APIError 带 status 字段）映射到 AGENT_INTEGRATION.md 规定的 HTTP 状态码。
// 文档约定：LLM 错误 = 502；其他未预期 = 500。timeout 单独按错误信息里有 /timeout/i 判定。
function classifyError(e: unknown): { status: number; body: { error: string; detail: string } } {
  const detail = e instanceof Error ? e.message : String(e);
  if (e && typeof e === "object" && "status" in e) {
    const status = (e as { status?: number }).status;
    if (typeof status === "number") {
      return { status: 502, body: { error: "llm_error", detail: `${status}: ${detail}` } };
    }
  }
  if (/timeout|timed out|aborted/i.test(detail)) {
    return { status: 504, body: { error: "timeout", detail } };
  }
  return { status: 500, body: { error: "internal", detail } };
}

// 入参校验：messages 必须是数组。元素 shape 交给 OpenAI SDK 兜底校验。
function parseBody(req: Request): { ok: true; messages: unknown[] } | { ok: false; detail: string } {
  const body = req.body;
  if (!body || typeof body !== "object") return { ok: false, detail: "request body must be a JSON object" };
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return { ok: false, detail: "messages must be an array" };
  return { ok: true, messages };
}

// --- 路由 ---

// 健康检查：运维探活。
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// 一次性完成：跑完整 Agent 循环，返回最终的 assistant 消息。
app.post("/complete", async (req: Request, res: Response) => {
  const parsed = parseBody(req);
  if (!parsed.ok) {
    res.status(400).json({ error: "bad_request", detail: parsed.detail });
    return;
  }
  try {
    // runWithMessages 会内部 prepend SYSTEM_PROMPT，所以这里直接传 Python 给的数组即可。
    const content = await agent.runWithMessages(parsed.messages as never);
    res.json({ role: "assistant", content });
  } catch (e) {
    const { status, body } = classifyError(e);
    res.status(status).json(body);
  }
});

// 流式完成：Agent 同步跑完循环拿到 final answer 后，按小 chunk 通过 SSE 渲染出来。
// 工具调用完全在容器内完成，Python 端只看到最终文本的"打字机"效果。
app.post("/complete/stream", async (req: Request, res: Response) => {
  // 先设 SSE 头，再校验入参——保证错误也能走 SSE 通道。
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const parsed = parseBody(req);
  if (!parsed.ok) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: "bad_request", detail: parsed.detail })}\n\n`);
    res.end();
    return;
  }

  try {
    const content = await agent.runWithMessages(parsed.messages as never);

    // 按 Unicode 码点切块，避免 JS slice 把 emoji 的代理对拆开（Python utf-8 会炸）。
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const units = Array.from(content);
    for (let i = 0; i < units.length; i += DELTA_CHUNK_SIZE) {
      const chunk = units.slice(i, i + DELTA_CHUNK_SIZE).join("");
      await sleep(40);
      res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
    }

    // done 事件必须发一次，且必须包含完整最终 message（Python 据此落库）。
    res.write(
      `data: ${JSON.stringify({ done: true, message: { role: "assistant", content } })}\n\n`,
    );
    // SSE 结束标记。
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    const { body } = classifyError(e);
    res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Agent HTTP server listening on :${PORT}`);
});