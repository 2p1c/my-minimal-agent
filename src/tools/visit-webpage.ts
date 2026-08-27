import TurndownService from "turndown"; // 一个把 HTML 转成 Markdown 的库

import type { Tool } from "./types.js";

// 私有辅助函数（不导出，仅本文件内部使用）：把过长的文本截断，避免一次性喂给模型太多内容。
// 形参带类型注解，函数返回值类型写在冒号后。
function truncate(text: string, maxLength: number): string {
  // 三元运算符：条件 ? (为真时的值) : (为假时的值)。等价于 if/else 的简写。
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

// 实现 Tool 接口的类：抓取网页内容并转成 markdown。
export class VisitWebpageTool implements Tool {
  // 类的字段。TS 会根据赋的值自动推断类型（此处推断为字符串字面量）。
  name = "visit_webpage";
  description =
    "Visits a webpage at the given URL and reads its content as a markdown string. Use this to browse webpages.";
  parameters = {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL of the webpage to visit." },
    },
    required: ["url"],
  } as const;
  // `as const`：把对象/数组标记为“只读且类型收紧为字面量值”，保证与 Tool 接口里的精确类型匹配。

  // 构造参数带 `private`，会自动生成私有字段 maxOutputLength（网页转 markdown 后最多保留的字符数）。
  constructor(private maxOutputLength = 40000) {}

  // 实现接口里声明的 execute 方法。`async` 使方法内部可以使用 `await`。
  async execute(args: Record<string, unknown>): Promise<string> {
    // 从参数对象里解构出 url 变量。
    // `as { url: string }` 是类型断言：告诉 TS“我知道这个对象的真实形状”，跳过默认的类型检查。
    const { url } = args as { url: string };
    try {
      // fetch 是 Node 内置的发 HTTP 请求的函数。AbortSignal.timeout(20_000) 表示 20 秒超时。
      // 下划线数字分隔符（20_000）只是写法上的分隔，等价于 20000。
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        // 反引号是模板字符串，`${...}` 里可以插入变量或表达式。
        return `Error fetching the webpage: HTTP ${response.status}`;
      }
      // 读取网页的原始 HTML 文本。
      const html = await response.text();
      // 用 Turndown 把 HTML 转成 markdown；replace 用正则把 3 个以上的连续换行压缩成 2 个。
      const markdown = new TurndownService()
        .turndown(html)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // 截断到 maxOutputLength 字符。
      return truncate(markdown, this.maxOutputLength);
    } catch (e) {
      // 出错时返回错误字符串（而不是抛异常），这样模型能看到错误并调整策略。
      return `Error fetching the webpage: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
