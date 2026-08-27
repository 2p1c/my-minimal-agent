import type { Tool } from "./types.js";

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
