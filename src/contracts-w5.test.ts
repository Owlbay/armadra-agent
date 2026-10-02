/**
 * 第五波契约的编译期断言（docs/wave5-plan.md §9、§10；[W5-C0]）。
 * 全部是可选字段或新增类型：旧代码不必改动就能编译；改契约时先改这里。
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AnthropicMessagesCompat,
  Model,
  OpenAIResponsesCompat,
  ProviderCompat,
  ProviderData,
} from "./ai/types.js";
import type { BuiltinProvider } from "./ai/providers/builtin.js";
import type { ContextEditEntry, ContextEditReason } from "./session/types.js";

describe("第五波 ①：模型元数据、内置渠道、Anthropic compat、image_budget", () => {
  it("Model 的 models.dev 元数据字段全部可选", () => {
    expectTypeOf<Model["family"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Model["knowledge"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Model["releaseDate"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Model["inputLimit"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Model["status"]>().toEqualTypeOf<"beta" | undefined>();
    const model: Model = {
      id: "m",
      name: "m",
      provider: "p",
      api: "anthropic-messages",
      input: ["text"],
      reasoning: false,
      maxTokens: 1,
      family: "claude-sonnet",
      knowledge: "2026-01",
      releaseDate: "2026-03-01",
      inputLimit: 200_000,
      status: "beta",
    };
    expect(model.status).toBe("beta");
  });

  it("内置供应商可以带内置渠道与缺省渠道", () => {
    expectTypeOf<BuiltinProvider["channels"]>().toEqualTypeOf<ProviderData["channels"]>();
    expectTypeOf<BuiltinProvider["defaultChannel"]>().toEqualTypeOf<string | undefined>();
    const provider: BuiltinProvider = {
      id: "deepseek",
      name: "DeepSeek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      envKeys: ["DEEPSEEK_API_KEY"],
      requiresApiKey: true,
      channels: [
        {
          name: "messages",
          api: "anthropic-messages",
          baseUrl: "https://api.deepseek.com/anthropic",
        },
      ],
      defaultChannel: "chat",
    };
    expect(provider.channels?.[0]?.name).toBe("messages");
  });

  it("Anthropic / Responses 的新 compat 开关可选，并入 ProviderCompat", () => {
    expectTypeOf<AnthropicMessagesCompat["sendInterleavedThinkingBeta"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<AnthropicMessagesCompat["sendCacheControl"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<OpenAIResponsesCompat["explicitCacheField"]>().toEqualTypeOf<
      "volcengine" | undefined
    >();
    const compat: ProviderCompat = {
      sendCacheControl: false,
      sendInterleavedThinkingBeta: false,
      explicitCacheField: "volcengine",
    };
    expect(compat.sendCacheControl).toBe(false);
  });

  it("ContextEditReason 含 image_budget", () => {
    expectTypeOf<"image_budget">().toExtend<ContextEditReason>();
    const edit: Pick<ContextEditEntry, "type" | "reason" | "replacement"> = {
      type: "context_edit",
      reason: "image_budget",
      replacement: "[earlier image omitted to fit request size]",
    };
    expect(edit.reason).toBe("image_budget");
  });
});
