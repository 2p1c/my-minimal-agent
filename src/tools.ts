import TurndownService from "turndown";
import { search } from "duck-duck-scrape";

/**
 * A tool the agent can call. The `parameters` field is a JSON Schema object
 * (the "object" wrapper) that gets passed directly to the OpenAI API.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: readonly string[];
  };
  execute: (args: Record<string, unknown>) => Promise<string>;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

export class VisitWebpageTool implements Tool {
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

  constructor(private maxOutputLength = 40000) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const { url } = args as { url: string };
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        return `Error fetching the webpage: HTTP ${response.status}`;
      }
      const html = await response.text();
      const markdown = new TurndownService()
        .turndown(html)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return truncate(markdown, this.maxOutputLength);
    } catch (e) {
      return `Error fetching the webpage: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

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
    const { results } = await search(query);
    if (results.length === 0) {
      return "No results found! Try a less restrictive/shorter query.";
    }
    const postprocessed = results
      .slice(0, this.maxResults)
      .map((r) => `[${r.title}](${r.url})\n${r.description}`)
      .join("\n\n");
    return "## Search Results\n\n" + postprocessed;
  }
}

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
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return "Error: TAVILY_API_KEY environment variable is not set.";
    }
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
    const data = (await response.json()) as {
      results?: { title: string; url: string; content: string }[];
    };
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
