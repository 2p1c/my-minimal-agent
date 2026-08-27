import { search } from "duck-duck-scrape"; // DuckDuckGo 搜索库（无需 API key）

import type { Tool } from "./types.js";

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
