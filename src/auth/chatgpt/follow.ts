/**
 * ChatGPT 订阅：请求渠道跟随当前登录方式。
 *
 * `siwc` 与 `codex` 两条渠道协议相同（openai-responses），只差端点、请求头与请求体白名单。会话里的模型是启动
 * （或选模型）时按当时的登录物化的；用户中途 `ama auth logout` 再换另一种方式登录后，同一会话的下一次请求
 * 拿到的 token 属于新的 flavor。这里在**请求时**按 token 的 flavor（活 token 登记）把模型改到对应渠道：
 *
 * - 模型引用没有显式 `@渠道`（`channelPinned` 不为 true）→ 改到登录 flavor 的渠道（端点、渠道头、compat）；
 * - 显式写了另一渠道 → 不动，协议层报 `chatgpt_flavor_mismatch`（chatgpt-backend.ts）；
 * - 不是 ChatGPT 后端、token 不是 OAuth、flavor 已一致 → 原样返回。
 *
 * 会话里记录的模型（`model_change`）不算显式：恢复时由 startup-steps 去掉渠道再解析。
 */

import { liveToken } from "../oauth/live.js";
import type { Model, OpenAIResponsesCompat, ProviderData } from "../../ai/types.js";

type ChatGptBackend = NonNullable<OpenAIResponsesCompat["chatgptBackend"]>;

function backendOf(compat: unknown): ChatGptBackend | undefined {
  if (typeof compat !== "object" || compat === null) return undefined;
  const value = (compat as { chatgptBackend?: unknown }).chatgptBackend;
  return value === "siwc" || value === "codex" ? value : undefined;
}

/** 按 `apiKey` 对应登录的 flavor 改写模型的渠道；无需改动时返回原对象。 */
export function followChatGptLogin(
  model: Model,
  provider: ProviderData | undefined,
  apiKey: string | undefined,
): Model {
  const current = backendOf(model.compat);
  if (current === undefined || model.channelPinned === true) return model;
  const flavor = liveToken(apiKey)?.flavor;
  if (flavor === undefined || flavor === current) return model;
  const channels = provider?.channels ?? [];
  const target =
    channels.find((c) => backendOf(c.compat) === flavor) ?? channels.find((c) => c.name === flavor);
  if (target === undefined) return model;
  const previous = channels.find((c) => c.name === model.channel);
  // 去掉旧渠道带来的头（codex 的 originator 等），换上新渠道的
  const headers: Record<string, string> = { ...model.headers };
  for (const name of Object.keys(previous?.headers ?? {})) delete headers[name];
  Object.assign(headers, target.headers);
  const next: Model = {
    ...model,
    api: target.api,
    baseUrl: target.baseUrl,
    channel: target.name,
    compat: { ...model.compat, ...target.compat, chatgptBackend: flavor },
  };
  if (Object.keys(headers).length > 0) next.headers = headers;
  else delete next.headers;
  return next;
}
