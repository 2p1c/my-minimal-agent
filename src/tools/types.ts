/**
 * 工具接口：任何工具都要实现下面这四个成员，才能被 Agent 调用。
 * interface 定义的是“形状”：只要一个对象满足这些字段的类型要求，就算实现了该接口。
 * `export` 导出，供其他文件 import。
 */
export interface Tool {
  name: string; // 工具名称，模型调用工具时使用这个名字
  description: string; // 给模型看的说明文字，模型据此判断何时该用这个工具
  // parameters 是 JSON Schema，描述这个工具接收哪些参数（OpenAI API 要求这种格式）。
  parameters: {
    type: "object"; // 参数整体是一个对象
    // 每个参数名 -> 它的类型描述，例如 { url: { type: "string" } }
    properties: Record<string, { type: string; description?: string }>;
    // `?` 表示该字段可选（可以不存在）；`readonly` 表示数组只读，不能用 push/splice 等修改。
    // `string[]` 表示“字符串数组”类型。
    required?: readonly string[];
  };
  // execute 是执行方法：接收一个参数对象，返回 Promise<string>（异步地返回一个字符串结果）。
  // 这里用箭头函数语法声明方法类型。
  execute: (args: Record<string, unknown>) => Promise<string>;
}
