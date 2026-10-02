/**
 * 入库的 models.dev 快照（docs/wave5-plan.md §2.1、docs/providers.md「模型元数据」）。
 *
 * `models-dev/*.json` 由 `scripts/update-models-dev.mjs` 生成并内联进 `models-dev-data.ts`（单 bundle，
 * 运行时不读 JSON 文件、不联网）。本模块解析内联数据，并提供与脚本同一口径的 `buildSnapshot()`
 * （`ama models refresh` 用它裁剪联网拉到的 api.json）与新旧对比 `diffSnapshots()`。
 */

import { MODELS_DEV_SOURCES } from "./models-dev-data.js";
import {
  ModelsDevIndex,
  keepForSnapshot,
  trimProvider,
  type ModelsDevData,
  type ModelsDevModel,
  type ModelsDevProvider,
} from "./models-dev.js";

export interface SnapshotMeta {
  /** ISO 8601；只在内容 sha256 变化时更新。 */
  fetchedAt: string;
  license: string;
  sha256: string;
  source: string;
  upstream: string;
}

/** 收录清单（`models-dev/_providers.json`）：供应商 id 与 OpenRouter 一类聚合商的前缀白名单。 */
export interface SnapshotList {
  providers: string[];
  prefixes?: Record<string, string[]>;
}

function parse<T>(id: string): T {
  const text = MODELS_DEV_SOURCES[id];
  if (text === undefined) throw new Error(`models.dev 快照缺少 ${id}`);
  return JSON.parse(text) as T;
}

let meta: SnapshotMeta | undefined;
let list: SnapshotList | undefined;
let data: ModelsDevData | undefined;
let index: ModelsDevIndex | undefined;

export function snapshotMeta(): SnapshotMeta {
  meta ??= parse<SnapshotMeta>("_meta");
  return meta;
}

export function snapshotList(): SnapshotList {
  list ??= parse<SnapshotList>("_providers");
  return list;
}

/** 文件形状（模型不带 id）→ 运行时形状（补 id）。 */
export function fromSnapshotFile(file: {
  id: string;
  name?: string;
  api?: string;
  models: Record<string, Omit<ModelsDevModel, "id">>;
}): ModelsDevProvider {
  const models: Record<string, ModelsDevModel> = {};
  for (const [id, model] of Object.entries(file.models)) models[id] = { id, ...model };
  return {
    id: file.id,
    ...(file.name !== undefined ? { name: file.name } : {}),
    ...(file.api !== undefined ? { api: file.api } : {}),
    models,
  };
}

/** 运行时形状 → 文件形状（去掉模型 id 与 tool_call，与脚本写出的 JSON 一致）。 */
export function toSnapshotFile(provider: ModelsDevProvider): unknown {
  const models: Record<string, unknown> = {};
  for (const [id, model] of Object.entries(provider.models)) {
    const { id: _id, tool_call: _toolCall, ...rest } = model;
    models[id] = rest;
  }
  return { ...provider, models };
}

/** 内置快照（同一进程只解析一次；调用方不得修改）。 */
export function builtinSnapshot(): ModelsDevData {
  if (data === undefined) {
    const out: ModelsDevData = {};
    for (const id of snapshotList().providers) out[id] = fromSnapshotFile(parse(id));
    data = out;
  }
  return data;
}

export function builtinSnapshotIndex(): ModelsDevIndex {
  index ??= new ModelsDevIndex(builtinSnapshot());
  return index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 按清单裁剪 api.json（与脚本同一口径）。`only` 只取其中几家。校验失败抛错：顶层不是对象、
 * 清单里的供应商缺失或过滤后没有模型（防止上游改版把数据清空）。
 */
export function buildSnapshot(
  raw: unknown,
  snapshot: SnapshotList = snapshotList(),
  only?: readonly string[],
): ModelsDevData {
  if (!isRecord(raw)) throw new Error("api.json 顶层不是对象");
  const out: ModelsDevData = {};
  for (const id of only ?? snapshot.providers) {
    const provider = raw[id];
    if (!isRecord(provider)) throw new Error(`api.json 缺少供应商 ${id}`);
    const prefixes = snapshot.prefixes?.[id];
    const trimmed = trimProvider(
      id,
      provider,
      (modelId, model) =>
        keepForSnapshot(model) &&
        (prefixes === undefined || prefixes.some((p) => modelId.startsWith(`${p}/`))),
    );
    if (Object.keys(trimmed.models).length === 0) throw new Error(`${id} 过滤后没有模型`);
    for (const model of Object.values(trimmed.models)) delete model.tool_call;
    out[id] = trimmed;
  }
  return out;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  /** `provider/model：context a → b；cost …`。 */
  changed: string[];
}

function priceText(model: ModelsDevModel): string {
  const c = model.cost;
  return c === undefined
    ? "无"
    : `${c.input}/${c.output}/${c.cache_read ?? "-"}/${c.cache_write ?? "-"}`;
}

/** 新旧对比（与脚本摘要同一口径）；只比较 `after` 里出现的供应商。 */
export function diffSnapshots(before: ModelsDevData, after: ModelsDevData): SnapshotDiff {
  const out: SnapshotDiff = { added: [], removed: [], changed: [] };
  for (const [providerId, provider] of Object.entries(after)) {
    const old = before[providerId]?.models ?? {};
    for (const id of Object.keys(old))
      if (provider.models[id] === undefined) out.removed.push(`${providerId}/${id}`);
    for (const [id, next] of Object.entries(provider.models)) {
      const prev = old[id];
      if (prev === undefined) {
        out.added.push(`${providerId}/${id}`);
        continue;
      }
      const parts: string[] = [];
      for (const key of ["context", "output"] as const) {
        if (prev.limit?.[key] !== next.limit?.[key])
          parts.push(`${key} ${prev.limit?.[key] ?? "无"} → ${next.limit?.[key] ?? "无"}`);
      }
      if (priceText(prev) !== priceText(next))
        parts.push(`cost ${priceText(prev)} → ${priceText(next)}`);
      if (parts.length > 0) out.changed.push(`${providerId}/${id}：${parts.join("；")}`);
    }
  }
  out.added.sort();
  out.removed.sort();
  out.changed.sort();
  return out;
}

/** 快照 ⊕ 覆盖：同 provider/model 以覆盖为准，其余沿用快照。 */
export function mergeSnapshot(base: ModelsDevData, override: ModelsDevData): ModelsDevData {
  const out: ModelsDevData = { ...base };
  for (const [id, provider] of Object.entries(override)) {
    const prev = base[id];
    out[id] = {
      ...prev,
      ...provider,
      models: { ...prev?.models, ...provider.models },
    };
  }
  return out;
}
