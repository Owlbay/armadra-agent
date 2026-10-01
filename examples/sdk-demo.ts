/**
 * SDK 演示：一个内存会话、一个自定义工具、流式输出与用量统计。
 *
 * 运行（先构建库，再用 Node 的类型剥离直接跑本文件）：
 *   pnpm build:lib
 *   node --experimental-strip-types examples/sdk-demo.ts                 # 缺省 fake/echo，无需 key
 *   AMA_DEMO_MODEL=anthropic/<model-id> node --experimental-strip-types examples/sdk-demo.ts
 *
 * 真实模型的 key 按 CLI 的顺序发现（auth.json → 环境变量，如 ANTHROPIC_API_KEY）。
 */

import { createAgentSession, defineTool } from "../dist/index.js";

const clock = defineTool<{ zone?: string }>({
  name: "clock",
  description: "Return the current time in ISO 8601 (UTC).",
  parameters: { type: "object", properties: { zone: { type: "string" } } },
  permission: "read",
  execute: async () => ({ content: new Date().toISOString() }),
});

const session = await createAgentSession({
  model: process.env["AMA_DEMO_MODEL"] ?? "fake/echo",
  tools: "none",
  extraTools: [clock],
  // 审批回调：只读工具不会走到这里；写入 / bash 在 default 权限模式下逐次询问。
  permission: { ask: async () => "deny" },
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
    process.stdout.write(event.assistantMessageEvent.delta);
  if (event.type === "tool_execution_start") process.stdout.write(`\n● ${event.toolName}\n`);
});

await session.prompt(process.argv[2] ?? "Hello from the ama SDK! What time is it?");
const stats = session.getStats();
process.stdout.write(
  `\n\n[${session.state.model?.provider}/${session.state.model?.id}] ` +
    `输入 ${stats.tokens.input} · 输出 ${stats.tokens.output} · 缓存命中率 ${
      stats.cacheHitRate === undefined ? "?" : `${Math.round(stats.cacheHitRate * 100)}%`
    }\n`,
);
await session.dispose();
