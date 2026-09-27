// 副作用导入：把 .env 里的环境变量读进 process.env。
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
// Express —— Node 上最常用的 HTTP 框架。
import express from "express";
import type { Request, Response } from "express";

import { AdmissionGate, SaturatedError } from "./admission.js";
import { mmagent, ResumeError } from "./agent.js";
import type { LoopEvent, LoopListener, ResumeResult, RunOutcome, TokenUsage } from "./agent.js";
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

// 满员时让客户端隔 1 秒再试。这是提示，不是承诺。
const RETRY_AFTER_SEC = "1";

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return fallback;
  return n;
}

function isAbortError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";
}

function canWrite(res: Response): boolean {
  return !res.headersSent && !res.writableEnded && !res.destroyed;
}

type Lease = { signal: AbortSignal; release: () => void };

// 拿到名额才继续。队列已满返回 429；排队期间客户端断开则放弃，不启动 Agent。
async function admit(req: Request, res: Response, gate: AdmissionGate): Promise<Lease | undefined> {
  const signal = requestSignal(req, res);
  try {
    const release = await gate.acquire(signal);
    if (signal.aborted) {
      release();
      if (canWrite(res)) res.status(499).json({ error: "cancelled" });
      return undefined;
    }
    return { signal, release };
  } catch (e) {
    if (e instanceof SaturatedError) {
      if (canWrite(res)) {
        res.setHeader("Retry-After", RETRY_AFTER_SEC);
        res.status(429).json({
          error: "overloaded",
          detail: "too many concurrent agent runs",
        });
      }
      return undefined;
    }
    if (isAbortError(e)) {
      if (canWrite(res)) res.status(499).json({ error: "cancelled" });
      return undefined;
    }
    throw e;
  }
}

function requestSignal(req: Request, res: Response): AbortSignal {
  const ac = new AbortController();
  // POST body 读完就会结束 request；只能看 response 是否被客户端掐掉。
  res.on("close", () => {
    if (!res.writableEnded && !ac.signal.aborted) ac.abort();
  });
  return ac.signal;
}

function usagePayload(usage: TokenUsage): TokenUsage {
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
}

function sendJsonOutcome(res: Response, outcome: RunOutcome): void {
  if (outcome.type === "cancelled") {
    res.status(499).json({ error: "cancelled", usage: usagePayload(outcome.usage) });
    return;
  }
  if (outcome.type === "interrupt") {
    res.json({
      interrupt: true,
      run_id: outcome.runId,
      pending: outcome.pending,
      usage: usagePayload(outcome.usage),
    });
    return;
  }
  res.json({
    role: "assistant",
    content: outcome.content,
    usage: usagePayload(outcome.usage),
  });
}

function writeSse(res: Response, event: string | undefined, data: unknown): void {
  if (res.writableEnded) return;
  try {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    const flushable = res as Response & { flush?: () => void };
    flushable.flush?.();
  } catch {
    // 客户端已断开
  }
}

function onLoopEvent(res: Response): LoopListener {
  return (evt: LoopEvent) => {
    if (LOOP_LOG) console.log("[loop]", JSON.stringify(evt));
    if (LOOP_EVENTS) writeSse(res, "loop", evt);
  };
}

// 正文 delta 已在模型生成时写过。这里只补上没流过的收尾文本（例如步数耗尽），然后发 done。
function sendStreamOutcome(res: Response, outcome: RunOutcome, streamed: boolean): void {
  if (res.writableEnded) return;
  if (outcome.type === "cancelled") {
    writeSse(res, "cancelled", { cancelled: true, usage: usagePayload(outcome.usage) });
    res.end();
    return;
  }
  if (outcome.type === "interrupt") {
    writeSse(res, "interrupt", {
      run_id: outcome.runId,
      pending: outcome.pending,
      usage: usagePayload(outcome.usage),
    });
    res.end();
    return;
  }
  if (outcome.type === "max_steps" || !streamed) {
    if (outcome.content) writeSse(res, undefined, { delta: outcome.content });
  }
  writeSse(res, undefined, {
    done: true,
    message: { role: "assistant", content: outcome.content },
    usage: usagePayload(outcome.usage),
  });
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

export type CreateAppOptions = {
  admission?: AdmissionGate;
};

export function createApp(agent: mmagent, options: CreateAppOptions = {}): express.Express {
  // 同时在跑的 Agent 默认 8 个，短突发最多再排 16 个。再多直接 429，
  // 避免对话内存、连接和上游配额一起被打满。可用环境变量覆盖。
  const gate =
    options.admission ??
    new AdmissionGate(envInt("AGENT_MAX_INFLIGHT", 8, 1), envInt("AGENT_MAX_WAITING", 16, 0));

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // 健康检查：运维探活。
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // /compact：压缩 old 消息，不跑工具循环。
  app.post("/compact", async (req: Request, res: Response) => {
    const parsed = parseBody(req);
    if (!parsed.ok) {
      res.status(400).json({ error: "bad_request", detail: parsed.detail });
      return;
    }
    const lease = await admit(req, res, gate);
    if (!lease) return;
    try {
      const result = await agent.compact(parsed.messages as never, lease.signal);
      res.json({
        compacted: result.compacted,
        skipped: result.skipped,
        notice: result.notice,
        usage: usagePayload(result.usage),
      });
    } catch (e) {
      const { status, body } = classifyError(e);
      res.status(status).json(body);
    } finally {
      lease.release();
    }
  });

  // 一次性完成：跑完整 Agent 循环，返回最终的 assistant 消息。
  app.post("/complete", async (req: Request, res: Response) => {
    const parsed = parseBody(req);
    if (!parsed.ok) {
      res.status(400).json({ error: "bad_request", detail: parsed.detail });
      return;
    }
    const lease = await admit(req, res, gate);
    if (!lease) return;
    try {
      const outcome = await agent.runWithMessages(
        parsed.messages as never,
        undefined,
        parsed.identity,
        lease.signal,
      );
      sendJsonOutcome(res, outcome);
    } catch (e) {
      const { status, body } = classifyError(e);
      res.status(status).json(body);
    } finally {
      lease.release();
    }
  });

  // 流式完成：模型每吐出一段正文就写一条 delta。工具仍在服务端执行。
  // 同一轮里先写字再调工具时，那些字也会作为 delta 发出；done 的 content 只含最终回答。
  app.post("/complete/stream", async (req: Request, res: Response) => {
    const parsed = parseBody(req);
    if (!parsed.ok) {
      // 入参错误仍走 SSE，和原来一样。过载在设 SSE 头之前用 429 拒绝，客户端能按状态码重试。
      setSseHeaders(res);
      writeSse(res, "error", { error: "bad_request", detail: parsed.detail });
      res.end();
      return;
    }

    const lease = await admit(req, res, gate);
    if (!lease) return;
    setSseHeaders(res);

    let streamed = false;
    const onDelta = (text: string) => {
      streamed = true;
      writeSse(res, undefined, { delta: text });
    };

    let outcome: RunOutcome;
    try {
      outcome = await agent.runWithMessages(
        parsed.messages as never,
        onLoopEvent(res),
        parsed.identity,
        lease.signal,
        onDelta,
      );
    } catch (e) {
      const { body } = classifyError(e);
      writeSse(res, "error", body);
      res.end();
      return;
    } finally {
      lease.release();
    }
    sendStreamOutcome(res, outcome, streamed);
  });

  app.post("/resume", async (req: Request, res: Response) => {
    const parsed = parseResumeBody(req);
    if (!parsed.ok) {
      res.status(400).json({ error: "bad_request", detail: parsed.detail });
      return;
    }
    const lease = await admit(req, res, gate);
    if (!lease) return;
    try {
      const outcome = await agent.resume(
        parsed.run_id,
        parsed.results,
        undefined,
        lease.signal,
      );
      sendJsonOutcome(res, outcome);
    } catch (e) {
      if (e instanceof ResumeError) {
        res.status(e.status).json({ error: e.error, detail: e.message });
        return;
      }
      const { status, body } = classifyError(e);
      res.status(status).json(body);
    } finally {
      lease.release();
    }
  });

  app.post("/resume/stream", async (req: Request, res: Response) => {
    const parsed = parseResumeBody(req);
    if (!parsed.ok) {
      setSseHeaders(res);
      writeSse(res, "error", { error: "bad_request", detail: parsed.detail });
      res.end();
      return;
    }

    const lease = await admit(req, res, gate);
    if (!lease) return;
    setSseHeaders(res);

    let streamed = false;
    const onDelta = (text: string) => {
      streamed = true;
      writeSse(res, undefined, { delta: text });
    };

    let outcome: RunOutcome;
    try {
      outcome = await agent.resume(
        parsed.run_id,
        parsed.results,
        onLoopEvent(res),
        lease.signal,
        onDelta,
      );
    } catch (e) {
      if (e instanceof ResumeError) {
        writeSse(res, "error", { error: e.error, detail: e.message });
        res.end();
        return;
      }
      const { body } = classifyError(e);
      writeSse(res, "error", body);
      res.end();
      return;
    } finally {
      lease.release();
    }
    sendStreamOutcome(res, outcome, streamed);
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
