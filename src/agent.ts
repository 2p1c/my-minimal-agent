import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./prompts.js";
import type { Tool } from "./tools.js";

type ChatMessage = OpenAI.ChatCompletionMessageParam;

export class Agent {
  private client: OpenAI;
  private tools: Map<string, Tool>;
  private toolSchemas: OpenAI.ChatCompletionTool[];

  constructor(
    private model: string,
    tools: Tool[] = [],
    private maxSteps = 10,
    baseURL?: string,
  ) {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL,
    });
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.toolSchemas = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async run(task: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: task },
    ];

    for (let step = 0; step < this.maxSteps; step++) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: this.toolSchemas,
        tool_choice: "auto",
      });
      const msg = response.choices[0].message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Push the assistant message (with tool_calls) so the model has context.
        messages.push({
          role: "assistant",
          content: msg.content,
          tool_calls: msg.tool_calls,
        });

        // Execute each tool call and feed the results back as "tool" messages.
        for (const call of msg.tool_calls) {
          if (call.type !== "function") continue;
          const tool = this.tools.get(call.function.name);
          if (!tool) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Unknown tool: ${call.function.name}`,
            });
            continue;
          }
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            args = {};
          }
          let result: string;
          try {
            result = await tool.execute(args);
          } catch (e) {
            result = `Error executing tool "${tool.name}": ${
              e instanceof Error ? e.message : String(e)
            }`;
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      } else {
        // No tool calls means the model is done — its text is the final answer.
        return msg.content ?? "No answer produced.";
      }
    }

    return "Could not solve task: Maximum number of steps exceeded.";
  }
}
