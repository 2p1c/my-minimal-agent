// 副作用导入：把 .env 里的环境变量读进 process.env。
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
// Express —— Node 上最常用的 HTTP 框架。
import express from "express";
import type { Request, Response } from "express";

import { mmagent, ResumeError } from "./agent.js";
import type { LoopEvent, LoopListener, ResumeResult, RunOutcome } from "./agent.js";
import { createTools } from "./tools/index.js";

// 生产镜像 Dockerfile 会设 NODE_ENV=production，默认既不打 loop 日志也不下发 SSE。
// 本地 `npm run server` 不设 NODE_ENV，默认两层都开。显式 AGENT_LOOP_EVENTS=0 / AGENT_LOOP_LOG=0 可关掉。
const isProd = process.env.NODE_ENV === "production";
const LOOP_EVENTS =
  process.env.AGENT_LOOP_EVENTS === "1" ||
  (process.env.AGENT_LOOP_EVENTS !== "0" && !isProd);
const LOOP_LOG =
  process.env.AGENT_LOOP_LOG === "1" ||
  (process.env.AGENT_LOOP_LOG !== "0" && !isProd);

// SSE 流式渲染时每个 delta 的 Unicode 码点数。8 左右能给出打字机感，又不会让事件数爆炸。
const DELTA_CHUNK_SIZE = 8;

const OUTCOMES = new Set(["ok", "error", "rejected"]);

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
function parseBody(
  req: Request,
): { ok: true; messages: unknown[]; identity?: string } | { ok: false; detail: string } {
  const body = req.body;
  if (!body || typeof body !== "object") return { ok: false, detail: "request body must be a JSON object" };
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return { ok: false, detail: "messages must be an array" };
  const identity = (body as { identity?: unknown }).identity;
  if (identity !== undefined && typeof identity !== "string") {
    return { ok: false, detail: "identity must be a string" };
  }
  return { ok: true, messages, identity };
}

function parseResumeBody(req: Request):
  | { ok: true; run_id: string; results: ResumeResult[] }
  | { ok: false; detail: string } {
  const body = req.body;
  if (!body || typeof body !== "object") return { ok: false, detail: "request body must be a JSON object" };
  const run_id = (body as { run_id?: unknown }).run_id;
  if (typeof run_id !== "string" || !run_id.trim()) {
    return { ok: false, detail: "run_id must be a non-empty string" };
  }
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return { ok: false, detail: "results must be an array" };
  const parsed: ResumeResult[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") return { ok: false, detail: "each result must be an object" };
    const tool_call_id = (item as { tool_call_id?: unknown }).tool_call_id;
    const content = (item as { content?: unknown }).content;
    const outcome = (item as { outcome?: unknown }).outcome;
    if (typeof tool_call_id !== "string" || !tool_call_id) {
      return { ok: false, detail: "tool_call_id must be a string" };
    }
    if (typeof content !== "string") return { ok: false, detail: "content must be a string" };
    if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
      return { ok: false, detail: "outcome must be ok, error, or rejected" };
    }
    parsed.push({ tool_call_id, content, outcome: outcome as ResumeResult["outcome"] });
  }
  return { ok: true, run_id, results: parsed };
}

function sendJsonOutcome(res: Response, outcome: RunOutcome): void {
  if (outcome.type === "interrupt") {
    res.json({
      interrupt: true,
      run_id: outcome.runId,
      pending: outcome.pending,
    });
    return;
  }
  res.json({ role: "assistant", content: outcome.content });
}

function writeSse(res: Response, event: string | undefined, data: unknown): void {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  const flushable = res as Response & { flush?: () => void };
  flushable.flush?.();
}

function onLoopEvent(res: Response): LoopListener {
  return (evt: LoopEvent) => {
    if (LOOP_LOG) console.log("[loop]", JSON.stringify(evt));
    if (LOOP_EVENTS) writeSse(res, "loop", evt);
  };
}

async function sendStreamOutcome(res: Response, outcome: RunOutcome): Promise<void> {
  if (outcome.type === "interrupt") {
    writeSse(res, "interrupt", { run_id: outcome.runId, pending: outcome.pending });
    res.end();
    return;
  }
  const content = outcome.content;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const units = Array.from(content);
  for (let i = 0; i < units.length; i += DELTA_CHUNK_SIZE) {
    const chunk = units.slice(i, i + DELTA_CHUNK_SIZE).join("");
    await sleep(40);
    writeSse(res, undefined, { delta: chunk });
  }
  writeSse(res, undefined, { done: true, message: { role: "assistant", content } });
  res.write("data: [DONE]\n\n");
  res.end();
}

function setSseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

export function createApp(agent: mmagent): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

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
      // runWithMessages 会内部 prepend 协议提示词和 identity，所以这里直接传 Python 给的数组即可。
      const outcome = await agent.runWithMessages(
        parsed.messages as never,
        undefined,
        parsed.identity,
      );
      sendJsonOutcome(res, outcome);
    } catch (e) {
      const { status, body } = classifyError(e);
      res.status(status).json(body);
    }
  });

  // 流式完成：Agent 同步跑完循环拿到 final answer 后，按小 chunk 通过 SSE 渲染出来。
  // 工具调用完全在容器内完成，Python 端只看到最终文本的"打字机"效果。
  app.post("/complete/stream", async (req: Request, res: Response) => {
    // 先设 SSE 头，再校验入参——保证错误也能走 SSE 通道。
    setSseHeaders(res);

    const parsed = parseBody(req);
    if (!parsed.ok) {
      writeSse(res, "error", { error: "bad_request", detail: parsed.detail });
      res.end();
      return;
    }

    try {
      const outcome = await agent.runWithMessages(
        parsed.messages as never,
        onLoopEvent(res),
        parsed.identity,
      );
      await sendStreamOutcome(res, outcome);
    } catch (e) {
      const { body } = classifyError(e);
      writeSse(res, "error", body);
      res.end();
    }
  });

  app.post("/resume", async (req: Request, res: Response) => {
    const parsed = parseResumeBody(req);
    if (!parsed.ok) {
      res.status(400).json({ error: "bad_request", detail: parsed.detail });
      return;
    }
    try {
      const outcome = await agent.resume(parsed.run_id, parsed.results);
      sendJsonOutcome(res, outcome);
    } catch (e) {
      if (e instanceof ResumeError) {
        res.status(e.status).json({ error: e.error, detail: e.message });
        return;
      }
      const { status, body } = classifyError(e);
      res.status(status).json(body);
    }
  });

  app.post("/resume/stream", async (req: Request, res: Response) => {
    setSseHeaders(res);

    const parsed = parseResumeBody(req);
    if (!parsed.ok) {
      writeSse(res, "error", { error: "bad_request", detail: parsed.detail });
      res.end();
      return;
    }

    try {
      const outcome = await agent.resume(
        parsed.run_id,
        parsed.results,
        onLoopEvent(res),
      );
      await sendStreamOutcome(res, outcome);
    } catch (e) {
      if (e instanceof ResumeError) {
        writeSse(res, "error", { error: e.error, detail: e.message });
        res.end();
        return;
      }
      const { body } = classifyError(e);
      writeSse(res, "error", body);
      res.end();
    }
  });

  return app;
}

function isDirectRun(metaUrl: string): boolean {
  const self = fileURLToPath(metaUrl);
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === self;
}

if (isDirectRun(import.meta.url)) {
  const model = process.env.MODEL;
  if (!model) {
    console.error("MODEL environment variable is not set.");
    process.exit(1);
  }
  const tools = createTools();
  const agent = new mmagent(model, tools, undefined, process.env.OPENAI_BASE_URL);
  const PORT = Number(process.env.PORT) || 8001;
  createApp(agent).listen(PORT, () => {
    console.log(`Agent HTTP server listening on :${PORT}`);
  });
}
