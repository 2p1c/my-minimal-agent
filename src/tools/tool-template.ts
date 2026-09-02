/**
 * ============================================================
 *  新工具模板：复制本文件、重命名（kebab-case，如 `calculator.ts`），
 *  按下面五处【标注】修改，再到 index.ts 里注册即可上线一个新工具。
 * ============================================================
 *
 * 使用步骤：
 *   1. 复制本文件为 `src/tools/<你的工具名>.ts`（文件名用 kebab-case）。
 *   2. 把下面的 `MyTool` 改成 PascalCase 的类名，逐个替换【标注】位置。
 *   3. 打开 `index.ts`，在 createTools() 返回数组里加一行 `new MyTool(...)`。
 *   4. 运行 `npm run typecheck` 确认编译通过。
 *
 * 注意事项：
 *   - Tool 接口来自 ./types.js，还可以可选设置 `execution: "browser"`；
 *     默认或不写则为服务端执行。不要在模板类上真的加上 browser 字段。
 *   - execute 出错时返回错误字符串而不是抛异常，模型看到错误后能自行调整策略。
 *   - 如果输出可能很长（如网页、搜索结果），务必像 visit-webpage.ts 那样截断，
 *     避免一次性喂给模型过多内容。
 */
import type { Tool } from "./types.js";

// 类名用 PascalCase：【1】改成你的工具类名。
export class MyTool implements Tool {
  // 【2】name 是模型调用工具时使用的名字，全局唯一，习惯上用 snake_case。
  //      命名要具体（如 "convert_currency"），避免和其他工具混淆。
  name = "my_tool";

  // 【3】description 是写给模型看的说明：这个工具做什么、什么时候该用它。
  //      用英文书写（与现有工具保持一致），描述越清楚模型调用越准确。
  description =
    "Describe what this tool does and when the model should use it.";

  // 【4】parameters 是 JSON Schema，描述 execute 接收哪些参数（OpenAI API 要求这种格式）。
  //      只支持扁平的对象参数：每个属性写 type 和给模型看的 description；
  //      必填参数列入 required 数组。保持 `as const` 不变，以满足 Tool 接口的精确类型。
  parameters = {
    type: "object",
    properties: {
      // 每个参数一项，例如：
      // input: { type: "string", description: "The input text to process." },
    },
    // required: ["input"],
  } as const;

  // 构造函数可接收配置项（可选）。参考现有写法：constructor(private maxResults = 10) {}
  // `private` 会自动生成同名私有字段；带默认值则注册时可省略参数。
  constructor() {}

  // 【5】execute 是具体执行逻辑：入参是一个对象，返回 Promise<string>。
  //      args 是 Record<string, unknown>，需要先用类型断言取出参数：
  //        const { input } = args as { input: string };
  async execute(args: Record<string, unknown>): Promise<string> {
    void args; // 占位：替换成真实逻辑时删掉这一行。

    // 建议：把核心逻辑包在 try/catch 里，出错时返回错误字符串（而不是抛异常），
    // 这样 Agent 能把错误信息反馈给模型继续运行。
    try {
      // ...在这里实现你的逻辑...
      return "Tool result here"; // 返回值是给模型看的 markdown 字符串。
    } catch (e) {
      return `Error running my_tool: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
