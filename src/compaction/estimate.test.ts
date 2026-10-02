import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../ai/types.js";
import {
  estimateContentTokens,
  estimateContextTokens,
  estimateMessageTokens,
  estimateTextTokens,
} from "./estimate.js";

describe("CJK 估算（D28 / C10）", () => {
  it("拉丁字符 / 4 向上取整", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
  });

  it("汉字、假名、谚文、全角标点每字 1 token", () => {
    expect(estimateTextTokens("中文估算")).toBe(4);
    expect(estimateTextTokens("ひらがなカタカナ")).toBe(8);
    expect(estimateTextTokens("한국어")).toBe(3);
    expect(estimateTextTokens("。，（）")).toBe(4);
  });

  it("混排：CJK 每字 1 + 其余合计 / 4", () => {
    // 4 个汉字 + 8 个 ASCII（"abc def " 含空格）
    expect(estimateTextTokens("abc def 修复缓存")).toBe(4 + 2);
  });

  it("补充平面扩展 B 的字（代理对）整字计 1", () => {
    expect(estimateTextTokens("𠀀𠀁")).toBe(2);
  });

  it("中文比「字符 / 4」口径高 4 倍：1 000 字 ≈ 1 000 token", () => {
    const text = "压".repeat(1000);
    expect(estimateTextTokens(text)).toBe(1000);
    expect(Math.ceil(text.length / 4)).toBe(250);
  });

  it("消息、内容块与上下文估算都按同一口径", () => {
    expect(estimateContentTokens([{ type: "text", text: "中文" }])).toBe(2);
    expect(
      estimateContentTokens([
        { type: "text", text: "中文" },
        { type: "image", data: "", mimeType: "image/png" },
      ]),
    ).toBe(2 + 1600);
    expect(estimateMessageTokens({ role: "user", content: "测试一下", timestamp: 0 })).toBe(4);
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想一想" },
        { type: "text", text: "好的" },
      ],
      api: "fake",
      provider: "fake",
      model: "echo",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "stop",
      timestamp: 0,
    };
    expect(estimateMessageTokens(assistant)).toBe(5);
    expect(
      estimateMessageTokens({ role: "compactionSummary", summary: "摘要", timestamp: 0 } as never),
    ).toBe(2);
    expect(
      estimateContextTokens([{ role: "user", content: "你好世界", timestamp: 0 }]).tokens,
    ).toBe(4);
  });
});
