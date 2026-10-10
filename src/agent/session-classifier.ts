/**
 * auto 权限模式的分类请求（§7.4 第 3 层）：把 permissions/classifier.ts 的 `complete` 接到会话上。
 *
 * - 模型：`options.permissionClassifier.model`（config `permission.autoModel`）解析成功就用它；
 *   否则（未配置、找不到；找不到时记一次 warning）[ME-D] 用会话供应商目录里的小模型（目录文件级
 *   `small`，D12；要能找到且有 key），再否则用当前会话模型；选择结果记一次 debug。
 * - [#153] 中转 / 自定义供应商（没有目录文件）：会话模型按 id 继承的目录条目 → 原厂 `small` →
 *   本供应商模型表（config `models[]`、发现缓存）里**已列出**的同一条目；不走合成路径。
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
import { catalogByAlias, catalogSmall } from "../ai/providers/catalog.js";
import type { SessionCore } from "./session-core.js";

export const CLASSIFY_USAGE_KIND = "permission_classify";

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

interface ClassifierState {
  warned: boolean;
  /** 已记过 debug 的选择（`provider/id`），换了才再记。 */
  logged?: string;
}

/** [#153] 会话模型继承的目录条目所属厂商的 `small`，在本供应商模型表里列出的条目 id。 */
function inferredSmall(core: SessionCore, session: Model): string | undefined {
  const hit = catalogByAlias(session.id);
  if (hit === undefined) return undefined;
  const origin = hit.ref.slice(0, hit.ref.indexOf("/"));
  const small = catalogSmall(origin);
  const target = `${origin}/${small}`;
  if (small === undefined || hit.ref === target) return undefined;
  const listed = core.options.providers.get(session.provider)?.models ?? [];
  return listed.find((m) => {
    if (m.id === small) return true;
    const entry = catalogByAlias(m.id);
    return entry?.ref === target && entry.tier === undefined;
  })?.id;
}

/** 分类用的小模型：会话供应商的目录 small，或 [#153] 推断出的同厂商小模型；能找到且 key 可用（或无需 key）才用。 */
async function smallModel(core: SessionCore, session: Model): Promise<Model | undefined> {
  const own = catalogSmall(session.provider);
  const small = own === undefined ? inferredSmall(core, session) : own;
  if (small === undefined || small === session.id) return undefined;
  const lookup = core.options.providers.findModel(`${session.provider}/${small}`);
  if (!lookup.ok) return undefined;
  try {
    const key = await core.options.providers.resolveApiKey(
      lookup.model.provider,
      lookup.model.channel,
    );
    return key.apiKey !== undefined || !lookup.provider.requiresApiKey ? lookup.model : undefined;
  } catch {
    return undefined;
  }
}

async function classifierModel(core: SessionCore, state: ClassifierState): Promise<Model> {
  const ref = core.options.permissionClassifier?.model;
  let model: Model | undefined;
  if (ref !== undefined && ref.trim() !== "") {
    const lookup = core.options.providers.findModel(ref);
    if (lookup.ok) model = lookup.model;
    else if (!state.warned) {
      state.warned = true;
      core.log("warn", `permission.autoModel ${ref} not found; ignored`);
    }
  }
  const session = core.model();
  model ??= (await smallModel(core, session)) ?? session;
  const picked = `${model.provider}/${model.id}`;
  if (state.logged !== picked) {
    state.logged = picked;
    core.log("debug", `permission classifier model: ${picked}`);
  }
  return model;
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
  const state: ClassifierState = { warned: false };
  const options = core.options.permissionClassifier;
  return new PermissionClassifier(
    async (prompt, signal) => {
      const model = await classifierModel(core, state);
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
  sandbox?: ClassifierRequest["sandbox"],
): ClassifierRequest {
  const request: ClassifierRequest = {
    toolName,
    input,
    cwd: core.cwd,
    projectRoot: projectRoot ?? core.cwd,
  };
  if (sandbox !== undefined) request.sandbox = sandbox;
  const user = latestUserText(core);
  if (user !== undefined) request.userMessage = user;
  return request;
}
