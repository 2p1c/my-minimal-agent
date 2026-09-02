// 导入 OpenAI SDK。它默认导出一个类，我们用 `new OpenAI({...})` 来创建客户端对象。
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
// 从 ./prompts.js 导入协议提示词和默认人设。ESM + NodeNext 要求本地导入写 `.js` 后缀。
import { IDENTITY, SYSTEM_PROMPT } from "./prompts.js";
// `import type` 表示只导入“类型”。这意味着 types.ts 只在类型检查时被需要，
// 运行时不会生成任何对应代码。这里只需要 Tool 这个类型来标注工具的类型。
import type { Tool } from "./tools/types.js";
import {
  FileCheckpointStore,
  type CheckpointStore,
  type PendingCall,
} from "./checkpoint.js";

export const BROWSER_EVAL_FAILURE_LIMIT = 3;
export const BROWSER_EVAL_STOPPED_MESSAGE =
  "已连续失败 3 次，停止改页面，向用户说明原因";

type LoopContext = {
  runId?: string;
  browserEvalFailures: number;
  stepsUsed: number;
  createdAt?: string;
};

// 给 OpenAI SDK 里的“聊天消息”类型起个别名，方便后面书写。
// 它本质上是一个对象，例如 { role: "user", content: "..." } 或 { role: "assistant", tool_calls: [...] }。
type ChatMessage = OpenAI.ChatCompletionMessageParam;

// 每一轮 ReAct loop 对外可见的事件。观察者（日志 / SSE）用它看清模型有没有调工具。
// 失败的观察者不能打断主循环，所以 emit 时会包一层 try。
export type LoopEvent =
  | {
      type: "llm";
      step: number;
      contentPreview: string;
      toolCalls: { id: string; name: string; arguments: string }[];
    }
  | {
      type: "tool_result";
      step: number;
      toolCallId: string;
      name: string;
      resultPreview: string;
    }
  | { type: "final"; step: number; content: string }
  | { type: "max_steps"; step: number; content: string }
  | { type: "interrupt"; step: number; runId: string; pending: InterruptPending[] };

export type LoopListener = (event: LoopEvent) => void;

export type InterruptPending = {
  tool_call_id: string;
  name: string;
  summary: string;
  code: string;
};

function toInterruptPending(call: PendingCall): InterruptPending {
  let summary = "";
  let code = "";
  try {
    const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    if (typeof args.summary === "string") summary = args.summary;
    if (typeof args.code === "string") code = args.code;
  } catch {
    // 保留空 summary/code
  }
  return { tool_call_id: call.toolCallId, name: call.name, summary, code };
}

export type RunOutcome =
  | { type: "final"; content: string }
  | { type: "max_steps"; content: string }
  | { type: "interrupt"; runId: string; pending: InterruptPending[] };

export type LlmClient = {
  chat: {
    completions: {
      create: (body: {
        model: string;
        messages: ChatMessage[];
        tools?: OpenAI.ChatCompletionTool[];
        tool_choice?: "auto";
      }) => Promise<{
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: OpenAI.ChatCompletionMessageToolCall[];
          };
        }>;
      }>;
    };
  };
};

export type AgentDeps = {
  client?: LlmClient;
  checkpoints?: CheckpointStore;
};

function preview(text: string, max = 500): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 调用方传入的 identity 视为不可信输入：去掉首尾空白并截断，避免把协议提示词挤出上下文。
const IDENTITY_MAX_LENGTH = 4000;

function normalizeIdentity(
  identity: string | undefined,
  fallback: string,
): string | undefined {
  const raw = identity === undefined ? fallback : identity;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length > IDENTITY_MAX_LENGTH
    ? trimmed.slice(0, IDENTITY_MAX_LENGTH)
    : trimmed;
}

// 拼装顺序：协议 → 身份 → 对话。协议始终在最前，调用方不能替换。
function assembleMessages(
  messages: ChatMessage[],
  identity: string | undefined,
  fallbackIdentity: string,
): ChatMessage[] {
  const assembled: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const id = normalizeIdentity(identity, fallbackIdentity);
  if (id) {
    assembled.push({ role: "system", content: id });
  }
  assembled.push(...messages);
  return assembled;
}

// 定义一个类。`export` 表示其他文件可以 import 使用它。
export class mmagent {
  // 类的私有字段：`private` 表示只能在类内部访问，外部不能直接读取。
  // 冒号后面的部分是类型注解；client 可注入假 LLM，默认仍是 OpenAI 客户端。
  private client: LlmClient;
  private checkpoints: CheckpointStore;
  // Map<K, V> 是键值对容器（类似字典）。这里以工具名称为键、工具对象为值，
  // 方便根据模型传来的工具名字快速查找到对应工具。
  // 泛型参数 <string, Tool> 表示“键的类型是 string，值的类型是 Tool”。
  private tools: Map<string, Tool>;
  // 传给 OpenAI API 的工具结构数组（API 要求这种特定格式才能识别工具）。
  private toolSchemas: OpenAI.ChatCompletionTool[];

  // 构造函数（constructor）。参数前面写 `private` 是一种简写语法（叫 parameter property）：
  // 它会自动声明一个同名私有字段并赋上参数的值，等价于在类里写 `private model: string;` 再 `this.model = model;`。
  // 带默认值的参数（如 tools = []、maxSteps = 10）：调用方没传时就用默认值。
  constructor(
    private model: string, // 要使用的模型名，例如 "gpt-4o" 或 "deepseek-chat"
    tools: Tool[] = [], // 工具列表，默认空数组。`Tool[]` 表示“Tool 的数组”。
    private maxSteps = 10, // 最多循环多少轮，防止模型无限调用工具导致死循环
    baseURL?: string, // 可选的 API 地址；`?` 表示该参数可以省略，省略时为 undefined（用 OpenAI 官方地址）
    private identity = IDENTITY, // 默认人设；HTTP 可用请求体 identity 按次覆盖
    deps: AgentDeps = {},
  ) {
    // 创建 OpenAI 客户端。apiKey 从环境变量读取（顶层的 dotenv 已把 .env 加载进 process.env）。
    // baseURL 若未提供则为 undefined，SDK 会使用默认的 OpenAI 官方地址。
    // 测试可注入 deps.client，避免真实网络调用。
    this.client =
      deps.client ??
      new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL,
      });
    this.checkpoints = deps.checkpoints ?? new FileCheckpointStore();

    // 把数组转成 Map 字典：
    //   tools.map((t) => [t.name, t])  -> 把每个工具变成 [工具名, 工具对象] 的二元数组
    //   new Map(...)                   -> 再包装成“按键查找”的字典
    this.tools = new Map(tools.map((t) => [t.name, t]));

    // 把工具转成 OpenAI API 要求的“function tool”结构（name / description / parameters）。
    this.toolSchemas = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  // `async` 方法：返回一个 Promise（表示“将来会给出结果”的异步值）。
  // 类型注解 `Promise<string>` 表示最终会给调用方一个字符串。
  // 方法内部可以用 `await` 暂停执行，直到某个异步操作完成。
  async run(task: string, onEvent?: LoopListener): Promise<string> {
    // CLI 入口：用单个 user 任务构造消息数组，与 HTTP 共用拼装（协议 + 身份 + 对话）。
    const outcome = await this.runLoop(
      assembleMessages(
        [{ role: "user", content: task }],
        undefined,
        this.identity,
      ),
      onEvent,
    );
    if (outcome.type === "interrupt") {
      return `Interrupted: browser tool pending (run_id=${outcome.runId}). Resume via HTTP POST /resume.`;
    }
    return outcome.content;
  }

  // HTTP 入口：接受外部传入的完整 messages 数组（含 user/assistant/tool/system 等）。
  // 始终把 SYSTEM_PROMPT prepend 到最前；identity 未传则用构造时的默认人设，传空字符串则不加身份层。
  // onEvent 可选：每一步 loop 回调一次，供本地调试；不传则行为与原来完全一样。
  async runWithMessages(
    messages: ChatMessage[],
    onEvent?: LoopListener,
    identity?: string,
  ): Promise<RunOutcome> {
    return this.runLoop(
      assembleMessages(messages, identity, this.identity),
      onEvent,
    );
  }

  // 共享的 ReAct 循环：把消息数组发给模型，按工具调用结果决定下一步或返回最终文本。
  private async runLoop(
    messages: ChatMessage[],
    onEvent?: LoopListener,
    ctx: LoopContext = { browserEvalFailures: 0, stepsUsed: 0 },
  ): Promise<RunOutcome> {
    const emit = (event: LoopEvent) => {
      if (!onEvent) return;
      try {
        onEvent(event);
      } catch {
        // 观察者抛错不能让对话失败。
      }
    };

    // for 循环，最多执行 maxSteps 轮。可从 checkpoint 的 stepsUsed 续跑；对外事件用 1-based。
    for (let step = ctx.stepsUsed; step < this.maxSteps; step++) {
      const stepNum = step + 1;
      // 调用 OpenAI 的聊天补全接口，拿到模型回复。
      // `await` 会等待网络请求完成后才继续执行下一行。
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages, // 整个对话历史
        tools: this.toolSchemas, // 告诉模型它有哪些工具可用
        tool_choice: "auto", // 允许模型自主决定是否调用工具
      });

      // 取第一条回复（choices 是候选回复列表，通常只用第一个）。
      const msg = response.choices[0].message;

      // 如果模型回复里带了工具调用请求，就执行这些工具。
      // `msg.tool_calls` 在模型没调用工具时是 undefined，所以先判断“存在且有内容”。
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        emit({
          type: "llm",
          step: stepNum,
          contentPreview: preview(msg.content ?? ""),
          toolCalls: msg.tool_calls
            .filter((call) => call.type === "function")
            .map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: preview(call.function.arguments || ""),
            })),
        });

        // 把带 tool_calls 的 assistant 消息也加进历史，让模型在下一轮能看到自己调用过哪些工具。
        messages.push({
          role: "assistant",
          content: msg.content,
          tool_calls: msg.tool_calls,
        });

        const pending: PendingCall[] = [];

        // for...of：遍历数组里的每一个工具调用。服务端先跑完，浏览器进 pending。
        for (const call of msg.tool_calls) {
          // 目前只支持 function 类型的调用，跳过其他类型（continue = 跳过本次循环）。
          if (call.type !== "function") continue;

          // 用工具名在 Map 字典里查找对应的工具对象。
          const tool = this.tools.get(call.function.name);
          if (!tool) {
            // 找不到工具时，把错误信息作为“工具结果”返回给模型，而不是让程序崩溃。
            const unknown = `Unknown tool: ${call.function.name}`;
            messages.push({
              role: "tool",
              tool_call_id: call.id, // 用 id 把这条结果关联到模型那次的工具调用
              content: unknown,
            });
            emit({
              type: "tool_result",
              step: stepNum,
              toolCallId: call.id,
              name: call.function.name,
              resultPreview: preview(unknown),
            });
            continue;
          }

          // 解析模型生成的工具参数：它是以 JSON 字符串形式传来的，需要转成对象。
          let args: Record<string, unknown> = {};
          // Record<string, unknown> 表示“键为字符串、值为任意未知类型”的对象。
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            // 如果 JSON 解析失败（比如模型返回了非法 JSON），就当作空参数处理。
            args = {};
          }

          if ((tool.execution ?? "server") === "browser") {
            if (ctx.browserEvalFailures >= BROWSER_EVAL_FAILURE_LIMIT) {
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: BROWSER_EVAL_STOPPED_MESSAGE,
              });
              emit({
                type: "tool_result",
                step: stepNum,
                toolCallId: call.id,
                name: call.function.name,
                resultPreview: preview(BROWSER_EVAL_STOPPED_MESSAGE),
              });
              continue;
            }

            const code = args.code;
            const emptyCode = typeof code !== "string" || code.trim() === "";
            if (emptyCode) {
              const emptyErr =
                'Error: run_browser_js requires a non-empty "code" string.';
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: emptyErr,
              });
              emit({
                type: "tool_result",
                step: stepNum,
                toolCallId: call.id,
                name: call.function.name,
                resultPreview: preview(emptyErr),
              });
              continue;
            }

            pending.push({
              toolCallId: call.id,
              name: call.function.name,
              arguments: call.function.arguments || "{}",
            });
            continue;
          }

          // 执行服务端工具，并把返回的字符串结果存进 result。
          let result: string;
          try {
            result = await tool.execute(args);
          } catch (e) {
            // 工具执行出错也不中断整个流程，而是把错误信息返回给模型，让模型调整策略。
            // `e instanceof Error` 判断异常是否是标准 Error 对象；`String(e)` 是兜底转成字符串。
            result = `Error executing tool "${tool.name}": ${
              e instanceof Error ? e.message : String(e)
            }`;
          }
          // 把工具结果作为 role: "tool" 的消息加入历史，并关联到对应的 tool_call_id。
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
          emit({
            type: "tool_result",
            step: stepNum,
            toolCallId: call.id,
            name: call.function.name,
            resultPreview: preview(result),
          });
        }

        if (pending.length > 0) {
          const now = new Date().toISOString();
          const runId = ctx.runId ?? randomUUID();
          await this.checkpoints.save({
            runId,
            messages,
            pending,
            browserEvalFailures: ctx.browserEvalFailures,
            stepsUsed: step + 1,
            createdAt: ctx.createdAt ?? now,
            updatedAt: now,
          });
          const interruptPending = pending.map(toInterruptPending);
          emit({
            type: "interrupt",
            step: stepNum,
            runId,
            pending: interruptPending,
          });
          return { type: "interrupt", runId, pending: interruptPending };
        }
      } else {
        // 模型没有调用工具，说明它已经给出最终答案，直接返回它的文本。
        // `??` 是空值合并运算符：若左边是 null/undefined，就使用右边的默认值。
        const content = msg.content ?? "No answer produced.";
        if (ctx.runId) {
          await this.checkpoints.delete(ctx.runId);
        }
        emit({ type: "final", step: stepNum, content });
        return { type: "final", content };
      }
    }

    // 循环次数耗尽仍没有得到答案（模型一直调用工具）。
    const exhausted = "Could not solve task: Maximum number of steps exceeded.";
    if (ctx.runId) {
      await this.checkpoints.delete(ctx.runId);
    }
    emit({ type: "max_steps", step: this.maxSteps, content: exhausted });
    return { type: "max_steps", content: exhausted };
  }
}
