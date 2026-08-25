// 只做“副作用”的导入：没有引入任何变量名，只是执行 dotenv 的配置加载逻辑，
// 它会把 .env 文件里的变量读进 process.env（后续代码就能用 process.env.XXX 读取了）。
import "dotenv/config";
// 导入项目内部的模块（位于 src/ 目录）。注意必须带 `.js` 后缀（ESM + NodeNext 模块系统的要求）。
import { Agent } from "./src/agent.js";
import {
  DuckDuckGoSearchTool,
  TavilySearchTool,
  VisitWebpageTool,
} from "./src/tools.js";

// 从环境变量读取模型名。process.env 是 Node 提供的对象，装着程序运行时的所有环境变量。
const model = process.env.MODEL;
if (!model) {
  // 如果 MODEL 没设置，打印错误信息并用退出码 1（表示失败）结束程序。
  console.error(
    "MODEL environment variable is not set. Add it to your .env file.",
  );
  process.exit(1);
}

// 创建 Agent 实例，传入模型名和一个工具数组。
// `new DuckDuckGoSearchTool(10)` 调用构造函数，参数 10 表示最多返回 10 条搜索结果。
const agent = new Agent(model, [
  // DuckDuckGo 不需要 API key，但可能被限流。如果限流，就换用下面那行的 Tavily 版本。
  new DuckDuckGoSearchTool(10),
  // new TavilySearchTool(10),
  new VisitWebpageTool(1000), // 网页内容转 markdown 后最多保留 1000 个字符
]);

// 顶层 await：因为 package.json 里 "type": "module"，模块顶层可以直接使用 await。
// agent.run(...) 返回 Promise<string>，await 等它执行完并拿到最终答案字符串。
const answer = await agent.run(
  "What time is it now?",
);

// 打印结果。
console.log("--------------------");
console.log(`The final answer is:\n\n${answer}`);
