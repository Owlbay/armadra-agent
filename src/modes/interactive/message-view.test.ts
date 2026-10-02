import { describe, expect, it } from "vitest";
import { Text, createTheme, plainTheme } from "../../tui.js";
import { MessageView, contentText, estimateTokens } from "./message-view.js";
import { assistant, lines, usage } from "./test-support.js";

const theme = plainTheme();

describe("消息区", () => {
  it("用户消息与 steer / host / followUp 标记，块之间空一行", () => {
    const view = new MessageView({ theme });
    view.addUser({ content: "修一下登录" });
    view.addUser({ content: "顺便加测试", origin: "steer" });
    view.addUser({ content: [{ type: "text", text: "画布有新连线" }], origin: "host" });
    view.addUser({ content: "然后提交", origin: "followUp" });
    expect(lines(view)).toEqual([
      "› 修一下登录",
      "",
      "↳ 插话  顺便加测试",
      "",
      "↳ 宿主  画布有新连线",
      "",
      "↳ 之后  然后提交",
    ]);
  });

  it("用户消息续行缩进 2 列；未知 origin 原样显示", () => {
    const view = new MessageView({ theme });
    view.addUser({ content: "第一行很长很长很长很长很长\n第二行" });
    view.addUser({ content: "x", origin: "canvas" });
    expect(lines(view, 16)).toEqual([
      "› 第一行很长很长",
      "  很长很长很长",
      "  第二行",
      "",
      "↳ canvas  x",
    ]);
  });

  it("相邻工具调用之间不空行；compact 全部不空行", () => {
    const view = new MessageView({ theme });
    view.addUser({ content: "u" });
    view.addTool(new Text("⏺ a"));
    view.addTool(new Text("⏺ b"));
    view.addNotice("info", "n");
    view.addTool(new Text("⏺ c"));
    expect(lines(view)).toEqual(["› u", "", "⏺ a", "⏺ b", "", "n", "", "⏺ c"]);
    const compact = new MessageView({ theme, compact: true });
    compact.addUser({ content: "u" });
    compact.endAssistant(assistant([{ type: "text", text: "a\n\nb" }]));
    compact.addNotice("warn", "w");
    expect(lines(compact)).toEqual(["› u", "a", "", "b", "! w"]);
  });

  it("助手流式：思考折叠为一行计数，Markdown 增量；结束后计数换成用量里的 reasoning", () => {
    const view = new MessageView({ theme });
    const thinking = { type: "thinking" as const, thinking: "a".repeat(40) };
    view.startAssistant(assistant([thinking]));
    expect(lines(view)).toEqual(["✻ 思考中…"]);
    view.updateAssistant(assistant([thinking, { type: "text", text: "# 标题\n\n正文 **加粗**" }]));
    expect(lines(view)).toEqual(["✻ 思考 · 10 token", "", "标题", "", "正文 加粗"]);
    view.endAssistant(
      assistant([thinking, { type: "text", text: "# 标题\n\n正文 **加粗**" }], {
        usage: usage({ reasoning: 1234 }),
      }),
    );
    expect(lines(view)[0]).toBe("✻ 思考 · 1.2k token");
    view.setThinkingExpanded(true);
    expect(lines(view).slice(0, 2)).toEqual(["✻ 思考 · 1.2k token  ▾", "  " + "a".repeat(40)]);
    view.setThinkingExpanded(false);
    expect(lines(view)[1]).toBe("");
  });

  it("思考展开最多 60 行；之后的新消息沿用展开状态", () => {
    const view = new MessageView({ theme });
    view.setThinkingExpanded(true);
    const long = Array.from({ length: 65 }, (_, i) => `t${i}`).join("\n");
    view.endAssistant(assistant([{ type: "thinking", thinking: long }]));
    const out = lines(view);
    expect(out).toHaveLength(62);
    expect(out[61]).toBe("  … 另 5 行");
  });

  it("showThinking full / hidden；markdown: false 原样输出", () => {
    const content = [
      { type: "thinking" as const, thinking: "先看文件" },
      { type: "text" as const, text: "**ok**" },
    ];
    const full = new MessageView({ theme, showThinking: "full", markdown: false });
    full.endAssistant(assistant(content));
    expect(lines(full)).toEqual(["✻ 思考 · 1 token  ▾", "  先看文件", "", "**ok**"]);
    const hidden = new MessageView({ theme, showThinking: "hidden" });
    hidden.endAssistant(assistant(content));
    expect(lines(hidden)).toEqual(["ok"]);
  });

  it("错误 / 中断 / 长度截断提示；只有工具调用的助手消息不占块", () => {
    const view = new MessageView({ theme });
    view.addUser({ content: "hi" });
    view.endAssistant(assistant([], { stopReason: "error", errorMessage: "401 unauthorized" }));
    view.endAssistant(assistant([{ type: "text", text: "写到" }], { stopReason: "aborted" }));
    view.endAssistant(assistant([{ type: "text", text: "很长" }], { stopReason: "length" }));
    view.startAssistant(assistant([]));
    view.endAssistant(
      assistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }], {
        stopReason: "toolUse",
      }),
    );
    expect(lines(view)).toEqual([
      "› hi",
      "",
      "✗ 401 unauthorized",
      "",
      "写到",
      "",
      "已中断",
      "",
      "很长",
      "",
      "输出达到长度上限",
    ]);
    expect(view.blockCount).toBe(4);
  });

  it("压缩摘要卡、重试、Hook 阻止与通知", () => {
    const view = new MessageView({ theme });
    view.addCompaction({
      summary: "目标：修登录\n已改 auth.ts\n待测\n还有一行",
      tokensBefore: 120_000,
      tokensAfter: 8_000,
    });
    view.addRetry(1, 3, 2000, "429 rate limited");
    view.addRetryFailed("529 overloaded");
    view.addHookBlocked("禁止提到密钥");
    view.addNotice("info", "宿主已连接");
    view.addNotice("warn", "上下文接近上限");
    expect(lines(view, 40)).toEqual([
      "▎ 上下文已压缩  120k → 8.0k token",
      "▎ 目标：修登录",
      "▎ 已改 auth.ts",
      "▎ 待测",
      "▎ … 另 1 行",
      "",
      "↻ 重试 1/3（2s 后）：429 rate limited",
      "",
      "✗ 重试失败：529 overloaded",
      "",
      "⛔ Hook 阻止：禁止提到密钥",
      "",
      "宿主已连接",
      "",
      "! 上下文接近上限",
    ]);
  });

  it("replay：用户、助手、工具调用（与结果配对）、摘要与可见自定义消息", () => {
    const view = new MessageView({ theme });
    const seen: string[] = [];
    view.replay(
      [
        { role: "compactionSummary", summary: "早先的对话", tokensBefore: 5000, timestamp: 0 },
        { role: "user", content: "读 README", timestamp: 0 },
        assistant(
          [
            { type: "text", text: "好的" },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } },
          ],
          { stopReason: "toolUse" },
        ),
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: "# hi",
          isError: false,
          timestamp: 0,
        },
        { role: "custom", customType: "x", content: "宿主备注", display: true, timestamp: 0 },
        { role: "custom", customType: "y", content: "隐藏", display: false, timestamp: 0 },
        { role: "branchSummary", summary: "另一分支", fromId: "e1", timestamp: 0 },
      ],
      {
        tool: (call, result) => {
          seen.push(`${call.name}:${result?.toolCallId ?? "-"}`);
          return new Text(`[tool ${call.name}]`);
        },
      },
    );
    expect(seen).toEqual(["read:c1"]);
    const out = lines(view, 30);
    expect(out).toContain("› 读 README");
    expect(out).toContain("好的");
    expect(out).toContain("[tool read]");
    expect(out).toContain("宿主备注");
    expect(out).not.toContain("隐藏");
    expect(out.join("\n")).toContain("分支摘要");
    expect(out.join("\n")).toContain("5.0k token");
  });

  it("reset 清空；彩色主题下用户前缀带样式；工具函数", () => {
    const view = new MessageView({ theme: createTheme("dark", { caps: { colors: 256 } }) });
    view.addUser({ content: "x" });
    expect(view.render(20)[0]).toContain("\x1b[");
    view.reset();
    expect(view.render(20)).toEqual([]);
    expect(estimateTokens("abcde")).toBe(2);
    expect(contentText([{ type: "image", data: "", mimeType: "image/png" }])).toBe("[图片]");
  });
});
