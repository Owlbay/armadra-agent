import { describe, expect, it } from "vitest";
import {
  IMAGE_OMITTED_TEXT,
  normalizeContext,
  normalizeContextInline,
  sanitizeText,
  systemReminderText,
} from "./context.js";
import type { TranscriptContext } from "./types.js";

const tool = (name: string, description = name) => ({
  name,
  description,
  parameters: { type: "object" as const },
});

const context: TranscriptContext = {
  messages: [
    {
      role: "system",
      sections: { preamble: "P", tools: "T", cwd: "/a" },
      toolsAdded: [tool("read"), tool("bash")],
      timestamp: 0,
    },
    {
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "AA", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    {
      role: "system",
      sections: { tools: null, cwd: "/b", host: "H" },
      toolsRemoved: ["bash"],
      toolsAdded: [tool("read", "v2"), tool("ls")],
      timestamp: 2,
    },
    { role: "user", content: "again", timestamp: 3 },
  ],
};

describe("normalizeContext", () => {
  it("system 折叠：节名级替换 / 删除，保持首次出现顺序；工具表差异重放", () => {
    const n = normalizeContext(context);
    expect(n.systemSections).toEqual([
      { name: "preamble", text: "P" },
      { name: "cwd", text: "/b" },
      { name: "host", text: "H" },
    ]);
    expect(n.systemPrompt).toBe("P\n\n/b\n\nH");
    expect(n.tools.map((t) => [t.name, t.description])).toEqual([
      ["read", "v2"],
      ["ls", "ls"],
    ]);
    expect(n.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(n.messages[0]?.content).toEqual(
      context.messages[1]?.role === "user" && context.messages[1].content,
    );
  });

  it("中途节补丁不改写开头：渲染成 system-reminder 的 user 消息按位置插回，相邻补丁合成一条", () => {
    const base: TranscriptContext = {
      messages: [
        { role: "system", sections: { preamble: "P", hooks: "h1" }, timestamp: 0 },
        { role: "system", sections: { host: "H0" }, timestamp: 0 },
        { role: "user", content: "q0", timestamp: 1 },
      ],
    };
    const later: TranscriptContext = {
      messages: [
        ...base.messages,
        { role: "system", sections: { hooks: "h2" }, timestamp: 2 },
        { role: "system", sections: { host: null }, toolsAdded: [tool("ls")], timestamp: 2 },
        { role: "user", content: "q1", timestamp: 3 },
      ],
    };
    const a = normalizeContext(base);
    const b = normalizeContext(later);
    expect(a.systemPrompt).toBe("P\n\nh1\n\nH0");
    expect(b.systemPrompt).toBe(a.systemPrompt);
    expect(b.systemSections).toEqual(a.systemSections);
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
    expect(b.messages.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect(b.messages[1]?.content).toBe(
      systemReminderText([
        'System prompt section "hooks" was updated:\n\nh2',
        'System prompt section "host" was removed.',
      ]),
    );
    expect(b.tools.map((t) => t.name)).toEqual(["ls"]);
  });

  it("只追加工具的补丁不插消息；补丁移除了工具 → 全部补丁折回开头", () => {
    const appended = normalizeContext({
      messages: [
        { role: "system", sections: { preamble: "P" }, toolsAdded: [tool("read")], timestamp: 0 },
        { role: "user", content: "q", timestamp: 1 },
        { role: "system", sections: {}, toolsAdded: [tool("ls")], timestamp: 2 },
      ],
    });
    expect(appended.messages).toHaveLength(1);
    expect(appended.tools.map((t) => t.name)).toEqual(["read", "ls"]);
    const removed = normalizeContext({
      messages: [
        { role: "system", sections: { preamble: "P" }, toolsAdded: [tool("read")], timestamp: 0 },
        { role: "user", content: "q", timestamp: 1 },
        { role: "system", sections: { hooks: "h" }, timestamp: 2 },
        { role: "system", sections: { tools: "T" }, toolsRemoved: ["read"], timestamp: 3 },
      ],
    });
    expect(removed.systemPrompt).toBe("P\n\nh\n\nT");
    expect(removed.messages).toHaveLength(1);
    expect(removed.tools).toEqual([]);
  });

  it("模态过滤：模型不收图片时替换为文字占位", () => {
    const n = normalizeContext(context, { model: { input: ["text"] } });
    expect(n.messages[0]?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: IMAGE_OMITTED_TEXT },
    ]);
  });

  it("inline：首条之后的 system 补丁按位置渲染，工具表用最终状态", () => {
    const n = normalizeContextInline(context);
    expect(n.systemPrompt).toBe("P\n\nT\n\n/a");
    expect(n.systemUpdates).toHaveLength(1);
    expect(n.systemUpdates[0]?.beforeIndex).toBe(1);
    expect(n.systemUpdates[0]?.text).toContain('System prompt section "tools" was removed.');
    expect(n.systemUpdates[0]?.text).toContain('System prompt section "cwd" was updated:\n\n/b');
    expect(n.tools.map((t) => t.name)).toEqual(["read", "ls"]);
  });

  it("sanitizeText 替换孤立代理项，保留合法 emoji", () => {
    expect(sanitizeText("a\uD800b👋")).toBe("a�b👋");
  });
});
