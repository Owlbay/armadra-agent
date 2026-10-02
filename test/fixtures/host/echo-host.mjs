/**
 * ESM 宿主适配器（第三波 §2.4 e2e）：经 `--host test/fixtures/host/echo-host.mjs` 加载。
 * 注册只读工具 host_echo、往系统提示 host 节加一段说明，并把 cache_miss / agent_settled
 * 经 ui.notify 报到 stderr（print 模式），验证 bundle 里的动态 import 与宿主事件桥接。
 */

export default {
  hostApi: 1,
  create(api) {
    api.tools.register({
      name: "host_echo",
      description: "Echo text back from the host.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      permission: "read",
      execute: async (input) => ({ content: `host echo: ${input.text}` }),
    });
    api.instructions.add({ kind: "text", name: "echo-host", text: "Echo host is attached." });
    api.events.on("cache_miss", (event) =>
      api.ui.notify(`echo-host cache_miss ${event.reason} ${event.missedTokens}`, "info"),
    );
    api.events.on("agent_settled", () => api.ui.notify(`echo-host settled ${api.mode}`, "info"));
    return { id: "echo-host" };
  },
};
