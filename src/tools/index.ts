/**
 * Tool Registry：整个项目获取 Tool 实例的唯一入口。
 * 具体 Tool 的实例化逻辑只放在这里。
 *
 * ── 如何添加一个新工具 ──────────────────────────────────────
 * 1. 复制本目录下的 `tool-template.ts` 为 `src/tools/<工具名>.ts`
 *    （文件名 kebab-case），按模板里的【标注】填写类名、name、
 *    description、parameters 和 execute 逻辑。
 * 2. 在本文件顶部 import 新工具的类，并在下方 createTools() 的
 *    返回数组里加一行 new YourTool(...)。
 * 3. 运行 npm run typecheck 确认编译通过。完成！
 *    不需要改动 agent.ts、server.ts 或 run_agent.ts —— 它们都
 *    只通过 createTools() 获取工具列表。
 * ────────────────────────────────────────────────────────────
 */
import type { Tool } from "./types.js";
import { RunBrowserJsTool } from "./run-browser-js.js";
import { DuckDuckGoSearchTool } from "./web-search.js";
import { VisitWebpageTool } from "./visit-webpage.js";

// 需要换 Tavily 时把 DuckDuckGo 那行注释掉、打开 Tavily 即可（需设置 TAVILY_API_KEY）。
export function createTools(): Tool[] {
  return [
    // ↓↓↓ 在这里注册新工具：new YourTool(...)，一行一个 ↓↓↓
    new DuckDuckGoSearchTool(10),
    // new TavilySearchTool(10),
    new VisitWebpageTool(1000),
    new RunBrowserJsTool(),
  ];
}
