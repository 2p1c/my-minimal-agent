import TurndownService from "turndown"; // 一个把 HTML 转成 Markdown 的库
import { search } from "duck-duck-scrape"; // DuckDuckGo 搜索库（无需 API key）

/**
 * 工具接口：任何工具都要实现下面这四个成员，才能被 Agent 调用。
 * interface 定义的是“形状”：只要一个对象满足这些字段的类型要求，就算实现了该接口。
 * `export` 导出，供其他文件 import。
 */
export interface Tool {
  name: string; // 工具名称，模型调用工具时使用这个名字
  description: string; // 给模型看的说明文字，模型据此判断何时该用这个工具
  // parameters 是 JSON Schema，描述这个工具接收哪些参数（OpenAI API 要求这种格式）。
  parameters: {
    type: "object"; // 参数整体是一个对象
    // 每个参数名 -> 它的类型描述，例如 { url: { type: "string" } }
    properties: Record<string, { type: string; description?: string }>;
    // `?` 表示该字段可选（可以不存在）；`readonly` 表示数组只读，不能用 push/splice 等修改。
    // `string[]` 表示“字符串数组”类型。
    required?: readonly string[];
  };
  // execute 是执行方法：接收一个参数对象，返回 Promise<string>（异步地返回一个字符串结果）。
  // 这里用箭头函数语法声明方法类型。
  execute: (args: Record<string, unknown>) => Promise<string>;
}

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

// 使用 DuckDuckGo 搜索的工具（不需要 API key，但可能被限流）。
export class DuckDuckGoSearchTool implements Tool {
  name = "web_search";
  description =
    "Performs a DuckDuckGo web search based on your query (think a Google search) and returns the top search results.";
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query to perform." },
    },
    required: ["query"],
  } as const;

  constructor(private maxResults = 10) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const { query } = args as { query: string };
    // 调用 duck-duck-scrape 库的 search 函数，从返回对象里解构出 results 数组。
    const { results } = await search(query);
    if (results.length === 0) {
      return "No results found! Try a less restrictive/shorter query.";
    }
    // 链式数组方法：
    //   slice(0, maxResults)  取前 maxResults 条
    //   map(r => ...)         把每条结果格式化成一行 markdown（箭头函数接收参数 r）
    //   join("\n\n")          用空行把所有行拼成一个长字符串
    const postprocessed = results
      .slice(0, this.maxResults)
      .map((r) => `[${r.title}](${r.url})\n${r.description}`)
      .join("\n\n");
    return "## Search Results\n\n" + postprocessed;
  }
}

// 使用 Tavily 搜索的工具（需要 TAVILY_API_KEY；当 DuckDuckGo 被限流时可替换使用）。
export class TavilySearchTool implements Tool {
  name = "tavily_search";
  description =
    "Performs a Tavily web search based on your query (think a Google search) and returns the top search results.";
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query to perform." },
    },
    required: ["query"],
  } as const;

  constructor(private maxResults = 10) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const { query } = args as { query: string };
    // 从环境变量读取 API key；process.env 是 Node 提供、装着所有环境变量的对象。
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return "Error: TAVILY_API_KEY environment variable is not set.";
    }
    // 调用 Tavily 的 HTTP API：发一个 POST 请求，body 是 JSON 字符串。
    // JSON.stringify 把对象序列化成 JSON 字符串。
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: this.maxResults,
      }),
    });
    if (!response.ok) {
      return `Error searching Tavily: HTTP ${response.status}`;
    }
    // 把响应解析成 JSON，并用类型断言声明它的结构（这里只声明代码用到的字段）。
    const data = (await response.json()) as {
      results?: { title: string; url: string; content: string }[];
    };
    // `??` 空值合并运算符：若 data.results 是 null/undefined，就用空数组兜底。
    const results = data.results ?? [];
    if (results.length === 0) {
      return "No results found! Try a less restrictive/shorter query.";
    }
    const postprocessed = results
      .map((r) => `[${r.title}](${r.url})\n${r.content}`)
      .join("\n\n");
    return "## Search Results\n\n" + postprocessed;
  }
}
