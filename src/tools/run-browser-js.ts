import type { Tool } from "./types.js";

export class RunBrowserJsTool implements Tool {
  name = "run_browser_js";
  execution = "browser" as const;
  description =
    "Modify the DOM of the current chat page by providing JavaScript for the page to eval. Changes vanish on refresh and are not stored on the server. Always include a human-readable summary of the visual change plus the executable JS. Do not use this for fetching URLs or searching the web.";
  parameters = {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "Short description of the DOM change for the human approval card. Must not be only code.",
      },
      code: {
        type: "string",
        description:
          "JavaScript to eval in the chat page context. Side effects are not persisted.",
      },
    },
    required: ["summary", "code"],
  } as const;

  async execute(_args: Record<string, unknown>): Promise<string> {
    void _args;
    return "Error: run_browser_js cannot execute on the server. The chat page must eval the code after approval.";
  }
}
