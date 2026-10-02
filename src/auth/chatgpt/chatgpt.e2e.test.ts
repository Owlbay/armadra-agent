/**
 * [W6-O] ChatGPT 真账户端到端（docs/wave6-plan.md §12-1）。**CI 永不运行**：只在 `AMA_E2E_CHATGPT=1` 时执行，
 * 且要求先在本机 `ama auth login chatgpt [--flavor codex]` 登录（读用户级 auth.json；不读任何其它应用的凭据）。
 *
 *   AMA_E2E_CHATGPT=1 pnpm vitest run src/auth/chatgpt/chatgpt.e2e.test.ts
 *   可选：AMA_E2E_CHATGPT_MODEL=<slug>（缺省取 discover 的第一个）
 *
 * 只打印 flavor、模型数、配额、错误码，不打印任何 token。
 */

import { describe, expect, it } from "vitest";
import { openAIResponsesApi } from "../../ai/apis/openai-responses.js";
import { ProviderRegistry } from "../../ai/providers/registry.js";
import type { StreamOptions, TranscriptContext } from "../../ai/types.js";
import { liveToken } from "../oauth/live.js";
import { listChatGptModels } from "./backend-client.js";

const enabled = process.env["AMA_E2E_CHATGPT"] === "1";

describe.skipIf(!enabled)("ChatGPT 真账户", () => {
  it("discover → 一个回合（带工具）→ 配额", async () => {
    const registry = new ProviderRegistry({ includeFake: false });
    const key = await registry.resolveApiKey("chatgpt");
    expect(key.source).toBe("oauth");
    const live = liveToken(key.apiKey);
    const provider = registry.get("chatgpt");
    const channel = provider?.channels?.find((c) => c.name === live?.flavor);
    const models = await listChatGptModels(fetch, channel?.baseUrl ?? "", {
      flavor: live?.flavor ?? "siwc",
      accessToken: key.apiKey ?? "",
      accountId: live?.accountId,
    });
    console.log(`flavor=${live?.flavor} models=${models.map((m) => m.id).join(",")}`);
    const slug = process.env["AMA_E2E_CHATGPT_MODEL"] ?? models[0]?.id ?? "gpt-5.5";
    const found = registry.findModel(`chatgpt/${slug}@${live?.flavor ?? "siwc"}`);
    if (!found.ok) throw new Error(`model ${slug} not found`);
    const context: TranscriptContext = {
      messages: [
        {
          role: "system",
          timestamp: 0,
          sections: { preamble: "Reply with one word." },
          toolsAdded: [
            {
              name: "echo",
              description: "Echo text back",
              parameters: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        },
        { role: "user", content: "Say hi.", timestamp: 0 },
      ],
    };
    const quotas: unknown[] = [];
    const options: StreamOptions = {
      signal: AbortSignal.timeout(120_000),
      sessionId: `ama-e2e-${Date.now()}`,
      onQuota: (q) => quotas.push(q),
    };
    if (key.apiKey !== undefined) options.apiKey = key.apiKey;
    const message = await openAIResponsesApi.stream(found.model, context, options).result();
    console.log(
      `stop=${message.stopReason} error=${message.errorMessage?.split(":")[0] ?? "-"} billing=${message.usage.billing} quota=${JSON.stringify(quotas)}`,
    );
    expect(message.stopReason).not.toBe("error");
    expect(message.usage.billing).toBe("subscription");
  }, 180_000);
});
