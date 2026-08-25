import "dotenv/config";
import { Agent } from "./agent.js";
import {
  DuckDuckGoSearchTool,
  TavilySearchTool,
  VisitWebpageTool,
} from "./tools.js";

const model = process.env.MODEL;
if (!model) {
  console.error(
    "MODEL environment variable is not set. Add it to your .env file.",
  );
  process.exit(1);
}

const agent = new Agent(model, [
  // DuckDuckGo needs no API key, but can hit rate limits. If that happens,
  // swap it for TavilySearchTool below (requires TAVILY_API_KEY).
  new DuckDuckGoSearchTool(10),
  // new TavilySearchTool(10),
  new VisitWebpageTool(1000),
]);

const answer = await agent.run(
  "What time is it now?",
);

console.log("--------------------");
console.log(`The final answer is:\n\n${answer}`);
