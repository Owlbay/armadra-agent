/**
 * 交互模式单元测试共用的小工具（只被 *.test.ts 引用）。[B7]
 */

import type { AssistantContentBlock, AssistantMessage, Usage } from "../../ai/types.js";
import type { Component } from "../../tui.js";
import { stripAnsi } from "../../tui.js";

export function usage(partial: Partial<Usage> = {}): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...partial };
}

export function assistant(
  content: AssistantContentBlock[],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "fake",
    provider: "fake",
    model: "echo",
    usage: usage(),
    stopReason: "stop",
    timestamp: 0,
    ...extra,
  };
}

/** 组件按宽度渲染、去样式、去行尾空白。 */
export function lines(component: Component, width = 60): string[] {
  return component.render(width).map((l) => stripAnsi(l).replace(/\s+$/, ""));
}
