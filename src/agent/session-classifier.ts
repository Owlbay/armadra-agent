/**
 * auto 权限模式的分类请求（§7.4 第 3 层）：把 permissions/classifier.ts 的 `complete` 接到会话上。
 *
 * - 模型：`options.permissionClassifier.model`（config `permission.autoModel`）解析成功就用它，
 *   否则（未配置、找不到）用当前会话模型；找不到时记一次 warning。
 * - 请求是**独立**的：只有分类系统提示与一条用户消息，不带会话转录与工具表；`purpose: "classify"`
 *   让会话层缓存包装直接透传（不观测、不暂停 / 触发保温、不成为下一次请求的前缀依据）；
 *   `cacheRetention: "none"`，关闭思考，`maxTokens` 256。
 * - 用量记一条 `usage{kind:"permission_classify"}` 条目：计入 `/session` 费用，不进上下文。
 */

import type { AssistantMessage, Model, StreamOptions, TranscriptContext } from "../ai/types.js";
import {
  CLASSIFIER_MAX_TOKENS,
  PermissionClassifier,
  type ClassifierRequest,
} from "../permissions/classifier.js";
import type { SessionCore } from "./session-core.js";

export const CLASSIFY_USAGE_KIND = "permission_classify";

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function classifierModel(core: SessionCore, warned: { done: boolean }): Model {
  const ref = core.options.permissionClassifier?.model;
  if (ref !== undefined && ref.trim() !== "") {
    const lookup = core.options.providers.findModel(ref);
    if (lookup.ok) return lookup.model;
    if (!warned.done) {
      warned.done = true;
      core.log("warn", `permission.autoModel ${ref} not found; using the session model`);
    }
  }
  return core.model();
}

/** 最近一条用户消息的文本（分类器输入的摘要来源）。 */
export function latestUserText(core: SessionCore): string | undefined {
  const message = core.agent.messages.findLast((m) => m.role === "user");
  if (message === undefined || message.role !== "user") return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
}

export function createSessionClassifier(core: SessionCore): PermissionClassifier {
  const warned = { done: false };
  const options = core.options.permissionClassifier;
  return new PermissionClassifier(
    async (prompt, signal) => {
      const model = classifierModel(core, warned);
      const context: TranscriptContext = {
        messages: [
          { role: "system", sections: { preamble: prompt.system }, timestamp: Date.now() },
          { role: "user", content: prompt.user, timestamp: Date.now() },
        ],
      };
      const streamOptions: StreamOptions = {
        signal,
        maxTokens: Math.min(CLASSIFIER_MAX_TOKENS, model.maxTokens || CLASSIFIER_MAX_TOKENS),
        cacheRetention: "none",
        thinkingLevel: "off",
        purpose: "classify",
      };
      try {
        const { apiKey } = await core.options.providers.resolveApiKey(
          model.provider,
          model.channel,
        );
        if (apiKey !== undefined) streamOptions.apiKey = apiKey;
      } catch {
        // 本地供应商无 key 也能用；真正缺 key 时请求会报错并按 ask 处理
      }
      const message = await core.stream(model, context, streamOptions).result();
      try {
        core.appendEntry({
          type: "usage",
          kind: CLASSIFY_USAGE_KIND,
          provider: model.provider,
          model: model.id,
          usage: message.usage,
        });
      } catch (error) {
        core.log("debug", `classifier usage not recorded: ${String(error)}`);
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? `classifier request ${message.stopReason}`);
      }
      return textOf(message);
    },
    {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      log: (level, message) => core.log(level, message),
    },
  );
}

/** gateToolCall 用：组装分类请求。 */
export function classifierRequest(
  core: SessionCore,
  toolName: string,
  input: unknown,
  projectRoot: string | undefined,
): ClassifierRequest {
  const request: ClassifierRequest = {
    toolName,
    input,
    cwd: core.cwd,
    projectRoot: projectRoot ?? core.cwd,
  };
  const user = latestUserText(core);
  if (user !== undefined) request.userMessage = user;
  return request;
}
