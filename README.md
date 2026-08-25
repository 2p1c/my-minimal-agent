# minimal-agent-ts

A minimalistic TypeScript LLM agent, reproducing [minimal-agent](https://github.com/Antropath/minimal-agent) with one key difference: instead of the "code agent" pattern (LLM writes Python executed in a sandbox), this version uses **OpenAI function calling** for tool use.

The core `agent.ts` module is ~70 lines. The agent follows the [ReAct framework](https://arxiv.org/abs/2210.03629): it loops through "reason → call tool → observe result" until it can produce a final answer.

## Usage

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your API key and model:
   ```bash
   cp .env.example .env
   ```
   Set `MODEL` to any OpenAI-compatible model identifier (e.g. `gpt-4o`, or `deepseek-chat` with `OPENAI_BASE_URL`). See the [OpenAI docs](https://platform.openai.com/docs) for compatible providers.

3. Run the example:
   ```bash
   npm start
   ```

The default example asks "What was the hottest day in 2024 and how much was the Dow Jones on that day?" and gives the agent web-search and web-visit tools.

## Architecture

- `src/agent.ts` — the `Agent` class: a tool-calling ReAct loop built on the OpenAI SDK.
- `src/tools.ts` — the `Tool` interface and three tools: `DuckDuckGoSearchTool` (no API key), `TavilySearchTool` (needs `TAVILY_API_KEY`), and `VisitWebpageTool`.
- `src/prompts.ts` — the system prompt describing how to use the tools.
- `src/run_agent.ts` — entry point: loads `.env`, constructs the agent, runs the example task.

Each tool exposes `name`, `description`, a JSON-Schema `parameters` object, and an `execute(args)` method. To add a tool, implement that shape and pass it to `new Agent(model, tools)`.

## Differences from the Python original

| Aspect | Python `minimal-agent` | TypeScript `minimal-agent-ts` |
|--------|------------------------|-------------------------------|
| Tool use | LLM generates Python, run by `LocalPythonExecutor` | OpenAI function calling |
| Final answer | Explicit `final_answer` tool call | Plain message with no tool calls |
| LLM access | `litellm` (multi-provider) | `openai` SDK (OpenAI-compatible) |
| System prompt | Code few-shot examples | Tool-usage instructions |
