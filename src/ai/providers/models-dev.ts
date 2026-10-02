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

/** 价格（$/1M token）；input 与 output 都有才保留。 */
export interface ModelsDevPrices {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

/**
 * 用到的模型字段（models.dev 原名）；其余裁剪时丢掉。快照只多存 family / knowledge /
 * release_date / limit.input / 价格档位 / interleaved / status（docs/wave5-plan.md §2.1）。
 */
export interface ModelsDevModel {
  id: string;
  name?: string;
  family?: string;
  /** 知识截止（`YYYY-MM` / `YYYY-MM-DD`）。 */
  knowledge?: string;
  release_date?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: ModelsDevPrices & {
    context_over_200k?: ModelsDevPrices;
    tiers?: (ModelsDevPrices & { tier: { size: number; type: "context" } })[];
  };
  interleaved?: true | { field: string };
  /** 只留 beta（deprecated 在快照里已过滤）。 */
  status?: "beta";
  canonical_model_id?: string;
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  /** 供应商级 OpenAI / Anthropic 兼容 baseUrl（协议线索，展示用）。 */
  api?: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevData = Record<string, ModelsDevProvider>;

/**
 * 原厂供应商（models.dev 的供应商 id，顺序即优先级）。通义在 `alibaba`、Meta 在 `meta`（Llama API
 * 在 `llama`）、智谱国际站在 `zai`、豆包在 `volcengine`、混元在 `tencent-tokenhub`；models.dev 没有
 * `qwen` 这样的供应商 id。
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
  "meta",
  "llama",
  "cohere",
  "xiaomi",
  "stepfun",
  "stepfun-ai",
  "volcengine",
  "tencent-tokenhub",
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
  family?: string;
  knowledge?: string;
  releaseDate?: string;
  inputLimit?: number;
  status?: "beta";
}

/**
 * 映射口径：`custom`（自定义模型补全，缺省）maxTokens 封顶 64k、缺的缓存价按输入价；
 * `catalog`（内置目录继承）maxTokens 不封顶（目录模型的输出上限就是原厂值，有意调小的写在目录里）、
 * 缺的缓存价记 0（与目录一贯写法一致：没有单独计价）。
 */
export type ModelsDevMapping = "custom" | "catalog";

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

function prices(value: unknown): ModelsDevPrices | undefined {
  if (!isRecord(value)) return undefined;
  const input = nonNegative(value["input"]);
  const output = nonNegative(value["output"]);
  if (input === undefined || output === undefined) return undefined;
  const out: ModelsDevPrices = { input, output };
  const read = nonNegative(value["cache_read"]);
  if (read !== undefined) out.cache_read = read;
  const write = nonNegative(value["cache_write"]);
  if (write !== undefined) out.cache_write = write;
  return out;
}

function trimCost(value: unknown): ModelsDevModel["cost"] {
  const base = prices(value);
  if (base === undefined || !isRecord(value)) return undefined;
  const out: NonNullable<ModelsDevModel["cost"]> = base;
  const over = prices(value["context_over_200k"]);
  if (over !== undefined) out.context_over_200k = over;
  const tiers: NonNullable<NonNullable<ModelsDevModel["cost"]>["tiers"]> = [];
  for (const tier of Array.isArray(value["tiers"]) ? value["tiers"] : []) {
    const p = prices(tier);
    const spec = isRecord(tier) ? tier["tier"] : undefined;
    const size = isRecord(spec) ? positive(spec["size"]) : undefined;
    if (p !== undefined && size !== undefined && isRecord(spec) && spec["type"] === "context")
      tiers.push({ ...p, tier: { size, type: "context" } });
  }
  if (tiers.length > 0) out.tiers = tiers;
  return out;
}

/** 字段裁剪（不过滤）；与 scripts/update-models-dev.mjs 的 trimModel 同一口径，另多留 tool_call。 */
function trimModel(id: string, raw: Record<string, unknown>): ModelsDevModel {
  const out: ModelsDevModel = { id };
  for (const key of ["name", "family", "knowledge", "release_date"] as const) {
    const v = raw[key];
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  for (const key of ["reasoning", "tool_call"] as const) {
    const v = raw[key];
    if (typeof v === "boolean") out[key] = v;
  }
  if (typeof raw["canonical_model_id"] === "string")
    out.canonical_model_id = raw["canonical_model_id"];
  if (raw["status"] === "beta") out.status = "beta";
  const modalities = raw["modalities"];
  if (isRecord(modalities)) {
    const input = strings(modalities["input"]);
    if (input) out.modalities = { input };
  }
  const limit = raw["limit"];
  if (isRecord(limit)) {
    const l: NonNullable<ModelsDevModel["limit"]> = {};
    for (const key of ["context", "input", "output"] as const) {
      const v = positive(limit[key]);
      if (v !== undefined) l[key] = v;
    }
    if (Object.keys(l).length > 0) out.limit = l;
  }
  const cost = trimCost(raw["cost"]);
  if (cost !== undefined) out.cost = cost;
  const interleaved = raw["interleaved"];
  if (interleaved === true) out.interleaved = true;
  else if (isRecord(interleaved) && typeof interleaved["field"] === "string")
    out.interleaved = { field: interleaved["field"] };
  return out;
}

/** 快照过滤：丢 deprecated、输出不含文本、上下文为 0 / 缺失、tool_call:false（docs/wave5-plan.md §2.1）。 */
export function keepForSnapshot(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (raw["status"] === "deprecated" || raw["tool_call"] === false) return false;
  const modalities = raw["modalities"];
  const output = isRecord(modalities) ? strings(modalities["output"]) : undefined;
  if (output !== undefined && !output.includes("text")) return false;
  const limit = raw["limit"];
  return isRecord(limit) && positive(limit["context"]) !== undefined;
}

/** 裁剪一家供应商；`keep` 给出时只留它放行的模型（模型 id 按字典序）。 */
export function trimProvider(
  providerId: string,
  provider: Record<string, unknown>,
  keep?: (modelId: string, raw: unknown) => boolean,
): ModelsDevProvider {
  const models: Record<string, ModelsDevModel> = {};
  const rawModels = isRecord(provider["models"]) ? provider["models"] : {};
  for (const modelId of Object.keys(rawModels).sort()) {
    const model = rawModels[modelId];
    if (!isRecord(model) || (keep !== undefined && !keep(modelId, model))) continue;
    models[modelId] = trimModel(modelId, model);
  }
  return {
    id: providerId,
    ...(typeof provider["name"] === "string" ? { name: provider["name"] } : {}),
    ...(typeof provider["api"] === "string" ? { api: provider["api"] } : {}),
    models,
  };
}

/** 校验并裁剪 api.json：只留用到的字段；形状不对的供应商 / 模型跳过。整体不是对象抛错。 */
export function trimModelsDev(raw: unknown): ModelsDevData {
  if (!isRecord(raw)) throw new Error("models.dev 数据不是对象");
  const out: ModelsDevData = {};
  for (const [providerId, provider] of Object.entries(raw)) {
    if (!isRecord(provider) || !isRecord(provider["models"])) continue;
    out[providerId] = trimProvider(providerId, provider);
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

function toCost(p: ModelsDevPrices, mapping: ModelsDevMapping): Omit<ModelCost, "tiers"> {
  const missing = mapping === "catalog" ? 0 : p.input;
  return {
    input: p.input,
    output: p.output,
    cacheRead: p.cache_read ?? missing,
    cacheWrite: p.cache_write ?? missing,
  };
}

/** models.dev 条目 → ama Model 字段（规则见 docs/providers.md「模型元数据」）。 */
export function modelsDevFields(
  model: ModelsDevModel,
  mapping: ModelsDevMapping = "custom",
): ModelsDevFields {
  const out: ModelsDevFields = {};
  if (model.name !== undefined) out.name = model.name;
  const context = positive(model.limit?.context);
  if (context !== undefined) out.contextWindow = Math.floor(context);
  const output = positive(model.limit?.output);
  if (output !== undefined) {
    const cap = mapping === "catalog" ? output : MODELS_DEV_MAX_OUTPUT;
    out.maxTokens = Math.floor(Math.min(output, cap, context ?? output));
  }
  const inputLimit = positive(model.limit?.input);
  if (inputLimit !== undefined && inputLimit !== context) out.inputLimit = Math.floor(inputLimit);
  const input = model.modalities?.input;
  if (input !== undefined) out.input = input.includes("image") ? ["text", "image"] : ["text"];
  if (model.reasoning !== undefined) out.reasoning = model.reasoning;
  if (model.tool_call !== undefined) out.toolCall = model.tool_call;
  const cost = model.cost;
  if (cost?.input !== undefined && cost.output !== undefined) {
    out.cost = toCost(cost, mapping);
    // 档位：优先通用 tiers；只有 context_over_200k 时折成 200k 一档。
    const tiers =
      cost.tiers !== undefined && cost.tiers.length > 0
        ? cost.tiers.map((t) => ({ inputTokensAbove: t.tier.size, ...toCost(t, mapping) }))
        : cost.context_over_200k !== undefined
          ? [{ inputTokensAbove: 200_000, ...toCost(cost.context_over_200k, mapping) }]
          : [];
    if (tiers.length > 0)
      out.cost.tiers = tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  }
  if (model.family !== undefined) out.family = model.family;
  if (model.knowledge !== undefined) out.knowledge = model.knowledge;
  if (model.release_date !== undefined) out.releaseDate = model.release_date;
  if (model.status === "beta") out.status = "beta";
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
