/**
 * models.dev 模型元数据（docs/providers.md「模型元数据：models.dev」）：裁剪、索引、匹配、映射。
 *
 * 数据源 `https://models.dev/api.json` 是「供应商 → 模型」两层表，同一个模型 id 会在几十家转售商下
 * 重复出现且取值不一。`ModelsDevIndex.match()` 按文档里的顺序挑一条：显式 `provider/model` →
 * `vendor/model` 形状的 id → 同名条目的 `canonical_model_id` 指向的原厂条目 → 原厂供应商 →
 * 多数一致 → 归一化 id（去前缀 / `:后缀` / `-latest` / 日期）后重试 → 未匹配。
 *
 * 本模块只做纯计算（不读文件、不联网）；缓存与拉取在 models-dev-cache.ts。
 */

import type { Model, ModelCost } from "../types.js";

/** 用到的模型字段（其余字段在写缓存时丢掉）。 */
export interface ModelsDevModel {
  id: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  canonical_model_id?: string;
  release_date?: string;
  open_weights?: boolean;
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevData = Record<string, ModelsDevProvider>;

/**
 * 原厂供应商（models.dev 的供应商 id，顺序即优先级）。通义在 `alibaba`、Llama 在 `llama`、
 * 智谱国际站在 `zai`；models.dev 没有 `qwen` / `meta` 这样的供应商 id。
 */
export const FIRST_PARTY_PROVIDERS: readonly string[] = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "moonshotai",
  "moonshotai-cn",
  "zhipuai",
  "zai",
  "alibaba",
  "alibaba-cn",
  "xai",
  "mistral",
  "minimax",
  "minimax-cn",
  "llama",
  "cohere",
  "xiaomi",
  "stepfun",
  "perplexity",
  "ai21",
  "upstage",
  "inception",
];

/** maxTokens 的上限：models.dev 给原厂上限（常与上下文相同），每次请求都会作为 max_tokens 发出。 */
export const MODELS_DEV_MAX_OUTPUT = 65_536;

export type MatchKind = "explicit" | "prefix" | "canonical" | "vendor" | "consensus" | "single";

export interface ModelsDevMatch {
  /** 选中条目 `provider/model`。 */
  ref: string;
  model: ModelsDevModel;
  kind: MatchKind;
  /** 经归一化才匹配到时的 id（如去掉日期后缀）。 */
  normalized?: string;
  /** 同名条目数。 */
  candidates: number;
  /** 多条取值不一致时的说明。 */
  warning?: string;
}

/** 映射到 ama Model 的字段（缺的不给）。 */
export interface ModelsDevFields {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  cost?: ModelCost;
  /** models.dev 的 tool_call；Model 上没有对应字段，只用于展示与写入过滤。 */
  toolCall?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function trimModel(id: string, raw: Record<string, unknown>): ModelsDevModel {
  const out: ModelsDevModel = { id };
  if (typeof raw["name"] === "string") out.name = raw["name"];
  if (typeof raw["family"] === "string") out.family = raw["family"];
  for (const key of ["attachment", "reasoning", "tool_call", "open_weights"] as const) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  if (typeof raw["canonical_model_id"] === "string")
    out.canonical_model_id = raw["canonical_model_id"];
  if (typeof raw["release_date"] === "string") out.release_date = raw["release_date"];
  const modalities = raw["modalities"];
  if (isRecord(modalities)) {
    const input = strings(modalities["input"]);
    const output = strings(modalities["output"]);
    out.modalities = { ...(input ? { input } : {}), ...(output ? { output } : {}) };
  }
  const limit = raw["limit"];
  if (isRecord(limit)) {
    const context = positive(limit["context"]);
    const output = positive(limit["output"]);
    out.limit = {
      ...(context !== undefined ? { context } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  }
  const cost = raw["cost"];
  if (isRecord(cost)) {
    const c: NonNullable<ModelsDevModel["cost"]> = {};
    for (const key of ["input", "output", "cache_read", "cache_write"] as const) {
      const v = nonNegative(cost[key]);
      if (v !== undefined) c[key] = v;
    }
    out.cost = c;
  }
  return out;
}

/** 校验并裁剪 api.json：只留用到的字段；形状不对的供应商 / 模型跳过。整体不是对象抛错。 */
export function trimModelsDev(raw: unknown): ModelsDevData {
  if (!isRecord(raw)) throw new Error("models.dev 数据不是对象");
  const out: ModelsDevData = {};
  for (const [providerId, provider] of Object.entries(raw)) {
    if (!isRecord(provider) || !isRecord(provider["models"])) continue;
    const models: Record<string, ModelsDevModel> = {};
    for (const [modelId, model] of Object.entries(provider["models"])) {
      if (isRecord(model)) models[modelId] = trimModel(modelId, model);
    }
    out[providerId] = {
      id: providerId,
      ...(typeof provider["name"] === "string" ? { name: provider["name"] } : {}),
      models,
    };
  }
  return out;
}

/**
 * 依次尝试的 id（小写、去重）：原样 → 去 `vendor/` 前缀 → 去 `:free` 一类后缀 → 去 `-latest` →
 * 去日期后缀（`-0902`、`-20250514`、`-2025-05-14`）。
 */
export function idCandidates(id: string): string[] {
  const out: string[] = [];
  const add = (value: string): void => {
    const v = value.trim();
    if (v !== "" && !out.includes(v)) out.push(v);
  };
  let s = id.trim().toLowerCase();
  add(s);
  s = s.slice(s.lastIndexOf("/") + 1);
  add(s);
  s = s.replace(/:[a-z0-9._-]+$/, "");
  add(s);
  s = s.replace(/-latest$/, "");
  add(s);
  s = s.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{6}|\d{4})$/, "");
  add(s);
  return out;
}

interface Entry {
  provider: string;
  id: string;
  model: ModelsDevModel;
}

function refOf(entry: Entry): string {
  return `${entry.provider}/${entry.id}`;
}

function vendorRank(provider: string): number {
  const i = FIRST_PARTY_PROVIDERS.indexOf(provider);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

function hasImage(model: ModelsDevModel): boolean {
  return model.modalities?.input?.includes("image") === true;
}

function signature(model: ModelsDevModel): string {
  return `${model.limit?.context ?? "?"}/${model.limit?.output ?? "?"}/${hasImage(model) ? "img" : "text"}`;
}

export class ModelsDevIndex {
  private readonly byId = new Map<string, Entry[]>();
  private readonly byRef = new Map<string, Entry>();
  readonly data: ModelsDevData;

  constructor(data: ModelsDevData) {
    this.data = data;
    for (const [providerId, provider] of Object.entries(data)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        const entry: Entry = { provider: providerId, id: modelId, model };
        const key = modelId.toLowerCase();
        const list = this.byId.get(key);
        if (list) list.push(entry);
        else this.byId.set(key, [entry]);
        this.byRef.set(`${providerId}/${modelId}`.toLowerCase(), entry);
      }
    }
  }

  get providerCount(): number {
    return Object.keys(this.data).length;
  }

  get modelCount(): number {
    return this.byRef.size;
  }

  /** `provider/model`（不分大小写）。 */
  get(ref: string): ModelsDevModel | undefined {
    return this.byRef.get(ref.toLowerCase())?.model;
  }

  /**
   * 匹配一个模型 id。`explicit` 是配置里的 `modelsDev: "provider/model"`：找得到就用，找不到返回
   * undefined（调用方 warning），不再回落到按 id 猜。
   */
  match(id: string, explicit?: string): ModelsDevMatch | undefined {
    if (explicit !== undefined) {
      const entry = this.byRef.get(explicit.toLowerCase());
      return entry
        ? { ref: refOf(entry), model: entry.model, kind: "explicit", candidates: 1 }
        : undefined;
    }
    if (id.includes("/")) {
      const entry = this.byRef.get(id.toLowerCase());
      if (entry) return { ref: refOf(entry), model: entry.model, kind: "prefix", candidates: 1 };
    }
    const candidates = idCandidates(id);
    for (const [i, key] of candidates.entries()) {
      const entries = this.byId.get(key);
      if (!entries || entries.length === 0) continue;
      const picked = this.choose(key, entries);
      if (i > 0 && key !== id.toLowerCase()) picked.normalized = key;
      return picked;
    }
    return undefined;
  }

  private choose(key: string, entries: Entry[]): ModelsDevMatch {
    const candidates = entries.length;
    let pool = entries;
    let owner: string | undefined;
    const votes = new Map<string, number>();
    for (const e of entries) {
      const c = e.model.canonical_model_id?.toLowerCase();
      if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
    }
    if (votes.size > 0) {
      const tail = (ref: string): string => ref.slice(ref.indexOf("/") + 1);
      const ranked = [...votes].sort(
        (a, b) => Number(tail(b[0]) === key) - Number(tail(a[0]) === key) || b[1] - a[1],
      );
      const canonical = ranked[0]?.[0] ?? "";
      const direct = this.byRef.get(canonical);
      if (direct) return { ref: refOf(direct), model: direct.model, kind: "canonical", candidates };
      // 原厂条目不在 models.dev 里：只在指向同一 canonical 的条目里挑，原厂只认 canonical 的厂商
      // （否则 alibaba 转售的 kimi 会被当成「原厂」）。
      owner = canonical.slice(0, canonical.indexOf("/"));
      const same = entries.filter((e) => e.model.canonical_model_id?.toLowerCase() === canonical);
      if (same.length > 0) pool = same;
    }
    const vendor = pool
      .filter((e) =>
        owner !== undefined
          ? e.provider === owner || e.provider === `${owner}-cn`
          : vendorRank(e.provider) < Number.POSITIVE_INFINITY,
      )
      .sort((a, b) => vendorRank(a.provider) - vendorRank(b.provider))[0];
    if (vendor) return { ref: refOf(vendor), model: vendor.model, kind: "vendor", candidates };
    if (pool.length === 1 && pool[0]) {
      return { ref: refOf(pool[0]), model: pool[0].model, kind: "single", candidates };
    }
    const groups = new Map<string, Entry[]>();
    for (const e of pool) {
      const sig = signature(e.model);
      const list = groups.get(sig);
      if (list) list.push(e);
      else groups.set(sig, [e]);
    }
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? pool;
    const chosen = best[0] as Entry;
    const match: ModelsDevMatch = {
      ref: refOf(chosen),
      model: chosen.model,
      kind: "consensus",
      candidates,
    };
    if (groups.size > 1) {
      match.warning =
        `${key}：models.dev 有 ${pool.length} 个条目、${groups.size} 种取值，` +
        `取多数（${best.length} 条：${signature(chosen.model)}）`;
    }
    return match;
  }
}

/** models.dev 条目 → ama Model 字段（规则见 docs/providers.md）。 */
export function modelsDevFields(model: ModelsDevModel): ModelsDevFields {
  const out: ModelsDevFields = {};
  if (model.name !== undefined) out.name = model.name;
  const context = positive(model.limit?.context);
  if (context !== undefined) out.contextWindow = Math.floor(context);
  const output = positive(model.limit?.output);
  if (output !== undefined) {
    out.maxTokens = Math.floor(Math.min(output, MODELS_DEV_MAX_OUTPUT, context ?? output));
  }
  const input = model.modalities?.input;
  if (input !== undefined) out.input = input.includes("image") ? ["text", "image"] : ["text"];
  if (model.reasoning !== undefined) out.reasoning = model.reasoning;
  if (model.tool_call !== undefined) out.toolCall = model.tool_call;
  const cost = model.cost;
  if (cost?.input !== undefined && cost.output !== undefined) {
    out.cost = {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cache_read ?? cost.input,
      cacheWrite: cost.cache_write ?? cost.input,
    };
  }
  return out;
}

/** 可由 models.dev 补的 Model 字段（展示来源用）。 */
export const ENRICHABLE_FIELDS = [
  "contextWindow",
  "maxTokens",
  "input",
  "reasoning",
  "cost",
] as const satisfies readonly (keyof Model)[];

export type EnrichableField = (typeof ENRICHABLE_FIELDS)[number];

/** 匹配方式的中文说明（表格与 `models list`）。 */
export function matchLabel(match: ModelsDevMatch | undefined): string {
  if (match === undefined) return "未匹配";
  const kind: Record<MatchKind, string> = {
    explicit: "显式",
    prefix: "前缀",
    canonical: "原厂",
    vendor: "原厂",
    consensus: "多数",
    single: "唯一",
  };
  const via = match.normalized !== undefined ? `，按 ${match.normalized}` : "";
  return `${kind[match.kind]} ${match.ref}${via}`;
}
