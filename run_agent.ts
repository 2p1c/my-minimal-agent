// 只做“副作用”的导入：没有引入任何变量名，只是执行 dotenv 的配置加载逻辑，
// 它会把 .env 文件里的变量读进 process.env（后续代码就能用 process.env.XXX 读取了）。
import "dotenv/config";
// 导入项目内部的模块（位于 src/ 目录）。注意必须带 `.js` 后缀（ESM + NodeNext 模块系统的要求）。
import { mmagent } from "./src/agent.js";
import { createTools } from "./src/tools/index.js";

// 从环境变量读取模型名。process.env 是 Node 提供的对象，装着程序运行时的所有环境变量。
const model = process.env.MODEL;
if (!model) {
  // 如果 MODEL 没设置，打印错误信息并用退出码 1（表示失败）结束程序。
  console.error(
    "MODEL environment variable is not set. Add it to your .env file.",
  );
  process.exit(1);
}

// 创建 Agent 实例，传入模型名和工具数组。工具统一通过 Tool Registry 获取。
const agent = new mmagent(model, createTools());

// 顶层 await：因为 package.json 里 "type": "module"，模块顶层可以直接使用 await。
// agent.run(...) 返回 Promise<string>，await 等它执行完并拿到最终答案字符串。
const answer = await agent.run("What time is it now?", (evt) => {
  console.log("[loop]", JSON.stringify(evt));
});

// 打印结果。
console.log("--------------------");
console.log(`The final answer is:\n\n${answer}`);
