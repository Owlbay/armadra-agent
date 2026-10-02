/**
 * 消息目录：errors（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I3]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 */

import type { ImageFileErrorDetail, ImageFitHint } from "../../tools/image-file.js";
import type { FieldSource } from "../../ai/providers/enrich.js";
import type { MatchKind } from "../../ai/providers/models-dev.js";
import type { ModelLookup } from "../../ai/types.js";
import { plural } from "../format.js";
import type { Messages } from "../types.js";

const EN_HINT: Record<ImageFitHint, string> = {
  resize_off: " (images.resize is off)",
  no_tool: " (no resize tool found: install ImageMagick, or sips on macOS)",
  still_too_large: " (resizing did not bring it under the limit)",
};

const ZH_HINT: Record<ImageFitHint, string> = {
  resize_off: "（images.resize 为 off）",
  no_tool: "（没找到缩放工具：装 ImageMagick，macOS 自带 sips）",
  still_too_large: "（缩放后仍超限）",
};

export const en = {
  /** [W6-I3] 图片附件：当前模型不收图片（`--image` / `@路径`）。 */
  imageUnsupported: (model: string | undefined) =>
    `${model ?? "The current model"} does not accept image input (the model's input has no image); switch to a model that supports images ` +
    `(marked "image" in ama models list, or give the model "input": ["text", "image"] in the config)`,
  /** [W6-I3] SDK（`createRuntime` / `createAgentSession`）。 */
  sdk: {
    noSubcommand: "createRuntime does not accept subcommands",
    modelNotFound: (ref: string) => `model not found: ${ref}`,
    noModel: "no model available: pass model, or configure a key for any provider",
    noPlan: "this session has no plan extension",
  },
  /** [W6-I3] 模型查找、models.dev 元数据（`src/ai/providers/**`）。 */
  models: {
    lookupFailure: (
      ref: string,
      reason: Extract<ModelLookup, { ok: false }>["reason"],
      list: string,
      hasCandidates: boolean,
    ): string => {
      switch (reason) {
        case "channel_not_found":
          return hasCandidates
            ? `channel not found: ${ref}; channels for this model: ${list}`
            : `channel not found: ${ref}; this model has no channels to choose (drop the @ suffix)`;
        case "provider_not_found":
          return hasCandidates
            ? `provider not found: ${ref}; closest providers: ${list}`
            : `provider not found: ${ref} (ama providers list shows configured providers)`;
        case "ambiguous":
          return `ambiguous model name: ${ref}; candidates: ${list}`;
        default:
          return hasCandidates
            ? `model not found: ${ref}; closest models: ${list}`
            : `model not found: ${ref} (ama models list shows available models)`;
      }
    },
    source: (source: FieldSource): string =>
      source === "catalog" ? "catalog" : source === "default" ? "default" : source,
    unmatched: "unmatched",
    match: (kind: MatchKind, ref: string, normalized: string | undefined): string => {
      const label: Record<MatchKind, string> = {
        explicit: "explicit",
        prefix: "prefix",
        canonical: "vendor",
        vendor: "vendor",
        consensus: "majority",
        single: "unique",
      };
      return `${label[kind]} ${ref}${normalized !== undefined ? `, via ${normalized}` : ""}`;
    },
    consensus: (key: string, entries: number, groups: number, best: number, signature: string) =>
      `${key}: models.dev has ${plural(entries, "entry", "entries")} with ${groups} different values; took the majority (${best}: ${signature})`,
    notObject: "models.dev data is not an object",
    snapshotMissing: (id: string) => `the models.dev snapshot has no ${id}`,
    apiNotObject: "api.json top level is not an object",
    apiMissingProvider: (id: string) => `api.json has no provider ${id}`,
    noModelsAfterFilter: (id: string) => `${id} has no models after filtering`,
    none: "none",
    describe: (via: string, providers: number, models: number) =>
      `models.dev: ${via} (${plural(providers, "provider")}, ${plural(models, "model")})`,
    viaSnapshot: (at: string) => `snapshot ${at}`,
    viaRefresh: (snapshot: string, refreshed: string) =>
      `snapshot ${snapshot} ⊕ refresh ${refreshed}`,
    refreshFailed: (reason: string) =>
      `models.dev refresh failed (${reason}); keeping the current data`,
    notListed: (unknown: string, choices: string) =>
      `not in the snapshot list: ${unknown}; choose from ${choices}`,
    refreshStatus: (
      status: "updated" | "unchanged" | "failed",
      providers: number,
      models: number,
      at: string | undefined,
    ) =>
      `models.dev: ${status === "updated" ? "refreshed" : status === "unchanged" ? "refreshed, no changes" : "refresh failed"} (${plural(providers, "provider")}, ${plural(models, "model")}${at ? `, ${at}` : ""})`,
    section: (kind: "added" | "removed" | "changed", count: number) =>
      `${kind === "added" ? "Added" : kind === "removed" ? "Removed upstream (snapshot entries kept)" : "Changed"} (${count}):`,
    more: (count: number) => `  …${count} more`,
    changed: (ref: string, parts: readonly string[]) => `${ref}: ${parts.join("; ")}`,
  },
  /** [W6-C0] 读图失败（`tools/image-file.ts` 的 `AmaError.detail`），`--image` 与 `@路径` 显示。 */
  imageFile: (d: ImageFileErrorDetail): string => {
    switch (d.reason) {
      case "missing":
        return `Image not found: ${d.path}`;
      case "not_file":
        return `Not a file: ${d.path}`;
      case "unsupported":
        return `Unsupported image (PNG / JPEG / GIF / WebP): ${d.path}`;
      case "too_large":
        return `Image exceeds the ${d.limitMb} limit (counted after base64): ${d.path} (${d.sizeMb})${d.hint === undefined ? "" : EN_HINT[d.hint]}`;
      case "too_wide":
        return `Image edge exceeds ${d.maxEdge} px: ${d.path}${d.size === undefined ? "" : ` (${d.size.width}×${d.size.height})`}${d.hint === undefined ? "" : EN_HINT[d.hint]}`;
    }
  },
};

export const zh = {
  imageUnsupported: (model) =>
    `${model ?? "当前模型"} 不接受图片输入（模型 input 没有 image）；换一个支持图像的模型再试` +
    `（ama models list 里标「图片」的，或在配置里给该模型写 "input": ["text", "image"]）`,
  sdk: {
    noSubcommand: "createRuntime 不接受子命令",
    modelNotFound: (ref) => `模型不存在：${ref}`,
    noModel: "没有可用模型：传 model，或配置任一供应商的 key",
    noPlan: "该会话没有装配 plan 扩展",
  },
  models: {
    lookupFailure: (ref, reason, list, hasCandidates) => {
      switch (reason) {
        case "channel_not_found":
          return hasCandidates
            ? `渠道不存在：${ref}；该模型可用渠道：${list}`
            : `渠道不存在：${ref}；该模型没有可选渠道（去掉 @ 后缀）`;
        case "provider_not_found":
          return hasCandidates
            ? `供应商不存在：${ref}；最接近的供应商：${list}`
            : `供应商不存在：${ref}（ama providers list 查看已配置的供应商）`;
        case "ambiguous":
          return `模型名有歧义：${ref}；候选：${list}`;
        default:
          return hasCandidates
            ? `模型不存在：${ref}；最接近的模型：${list}`
            : `模型不存在：${ref}（ama models list 查看可用模型）`;
      }
    },
    source: (source) => (source === "catalog" ? "目录" : source === "default" ? "缺省" : source),
    unmatched: "未匹配",
    match: (kind, ref, normalized) => {
      const label: Record<MatchKind, string> = {
        explicit: "显式",
        prefix: "前缀",
        canonical: "原厂",
        vendor: "原厂",
        consensus: "多数",
        single: "唯一",
      };
      return `${label[kind]} ${ref}${normalized !== undefined ? `，按 ${normalized}` : ""}`;
    },
    consensus: (key, entries, groups, best, signature) =>
      `${key}：models.dev 有 ${entries} 个条目、${groups} 种取值，取多数（${best} 条：${signature}）`,
    notObject: "models.dev 数据不是对象",
    snapshotMissing: (id) => `models.dev 快照缺少 ${id}`,
    apiNotObject: "api.json 顶层不是对象",
    apiMissingProvider: (id) => `api.json 缺少供应商 ${id}`,
    noModelsAfterFilter: (id) => `${id} 过滤后没有模型`,
    none: "无",
    describe: (via, providers, models) =>
      `models.dev：${via}（${providers} 家供应商、${models} 个模型）`,
    viaSnapshot: (at) => `快照 ${at}`,
    viaRefresh: (snapshot, refreshed) => `快照 ${snapshot} ⊕ 刷新 ${refreshed}`,
    refreshFailed: (reason) => `models.dev 刷新失败（${reason}），沿用现有数据`,
    notListed: (unknown, choices) => `不在收录清单里：${unknown}；可选 ${choices}`,
    refreshStatus: (status, providers, models, at) =>
      `models.dev：${status === "updated" ? "已刷新" : status === "unchanged" ? "已刷新，无变化" : "刷新失败"}（${providers} 家供应商、${models} 个模型${at ? `，${at}` : ""}）`,
    section: (kind, count) =>
      `${kind === "added" ? "新增" : kind === "removed" ? "上游删除（快照里的条目保留）" : "变化"}（${count}）：`,
    more: (count) => `  …另 ${count} 条`,
    changed: (ref, parts) => `${ref}：${parts.join("；")}`,
  },
  imageFile: (d) => {
    switch (d.reason) {
      case "missing":
        return `图片不存在：${d.path}`;
      case "not_file":
        return `不是文件：${d.path}`;
      case "unsupported":
        return `不是支持的图片（PNG / JPEG / GIF / WebP）：${d.path}`;
      case "too_large":
        return `图片超过 ${d.limitMb} 上限（按 base64 后计算）：${d.path}（${d.sizeMb}）${d.hint === undefined ? "" : ZH_HINT[d.hint]}`;
      case "too_wide":
        return `图片任一边超过 ${d.maxEdge} px：${d.path}${d.size === undefined ? "" : `（${d.size.width}×${d.size.height}）`}${d.hint === undefined ? "" : ZH_HINT[d.hint]}`;
    }
  },
} satisfies Messages<typeof en>;
