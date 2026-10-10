/**
 * [ME-C0] 模型调用效率批次的契约（docs/history/model-efficiency-plan.md §1）：新增的都是可选字段与签名，
 * 编译期断言形状与签名，运行期断言发给模型的固定文案。
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentSessionOptions } from "./agent/session-core.js";
import {
  toolRemovedReminder,
  toolRestoredReminder,
  toolUnavailableText,
} from "./agent/tool-availability.js";
import {
  MIN_OUTPUT_TOKENS,
  OUTPUT_HEADROOM_TOKENS,
  clampMaxTokens,
  maxTokensCaps,
  parseMaxTokensRejection,
} from "./ai/apis/max-tokens.js";
import type { PrefixFingerprint } from "./ai/cache/types.js";
import type { CatalogEntry, CatalogSourceFile } from "./ai/providers/catalog.js";
import type { AssistantMessage, ToolCallBlock } from "./ai/types.js";
import type { AgentDefinition } from "./agents/types.js";
import type { CompactionConfig, ModelConfig, RequestConfig } from "./config/types.js";
import type { SessionEntryInput, SessionManagerApi } from "./session/types.js";
import type { SubagentRequest, TaskInfo, ToolContext } from "./tools/types.js";

type ContextMode = "fork" | "fresh" | undefined;

describe("[ME-C0] 可选字段", () => {
  it("消息、指纹、目录、工具上下文、子 Agent 与配置", () => {
    expectTypeOf<ToolCallBlock["rawArguments"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AssistantMessage["retryAfterMs"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PrefixFingerprint["sections"]>().toEqualTypeOf<
      Record<string, string> | undefined
    >();
    expectTypeOf<CatalogEntry["aliases"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<CatalogSourceFile["small"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ToolContext["maxResultChars"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<SubagentRequest["context"]>().toEqualTypeOf<ContextMode>();
    expectTypeOf<AgentDefinition["context"]>().toEqualTypeOf<ContextMode>();
    expectTypeOf<TaskInfo["context"]>().toEqualTypeOf<ContextMode>();
    expectTypeOf<AgentSessionOptions["unavailableTools"]>().toEqualTypeOf<
      readonly string[] | undefined
    >();
    expectTypeOf<CompactionConfig["contextBudget"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<RequestConfig["streamIdleTimeoutMs"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ModelConfig["catalog"]>().toEqualTypeOf<string | false | undefined>();
    expectTypeOf<SessionManagerApi["fork"]>().toEqualTypeOf<
      (entryId: string, options?: { head?: SessionEntryInput }) => SessionManagerApi
    >();
  });
});

describe("[ME-C0] 固定文案与 max_tokens 签名", () => {
  it("工具可用性文案固定英文", () => {
    expect(toolUnavailableText("bash")).toBe('Tool "bash" is not available in this session.');
    expect(toolRemovedReminder("bash")).toBe(
      'Tool "bash" is no longer available in this session; calls to it are rejected.',
    );
    expect(toolRestoredReminder("bash")).toBe('Tool "bash" is available again.');
  });

  it("max-tokens.ts 的导出签名（实现归 ME-C）", () => {
    expect([MIN_OUTPUT_TOKENS, OUTPUT_HEADROOM_TOKENS]).toEqual([1024, 2048]);
    expectTypeOf(clampMaxTokens).toEqualTypeOf<
      (
        requested: number,
        window: number | undefined,
        estimatedInput: number,
        fixed: boolean,
      ) => number
    >();
    expectTypeOf(parseMaxTokensRejection).returns.toEqualTypeOf<
      { cap: number } | { overflow: true } | undefined
    >();
    expectTypeOf(maxTokensCaps).toEqualTypeOf<Map<string, number>>();
  });
});
