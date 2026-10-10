#!/usr/bin/env node
// 刷新入库的 models.dev 快照（docs/history/wave5-plan.md §2.3、docs/guides/providers.md「模型元数据」）。零依赖。
//
//   node scripts/update-models-dev.mjs [--url <url>] [--input <api.json>] [--out <dir>]
//        [--data-out <file>] [--list <_providers.json>] [--now <ISO>] [--min-providers <n>] [--dry-run]
//
// 拉取 api.json（或读 --input）→ 校验（顶层对象、供应商数 > --min-providers、清单里每家存在且过滤后 ≥ 1 条）
// → 按清单裁剪与过滤 → 规范化（键递归排序、2 空格缩进、末尾换行）→ 写 <out>/<provider>.json、
// <out>/_meta.json 与生成的 models-dev-data.ts → stdout 输出 Markdown 摘要（新增 / 删除 / 变化）。
// 内容不变时字节不变：_meta.json 的 fetchedAt 只在 sha256 变化时更新。
// 退出码：0 无变化或有变化；1 失败（不写任何文件）；3 删除比例 > 30%（文件照写，交人审）。
//
// 裁剪规则与 src/ai/providers/models-dev-snapshot.ts 的 buildSnapshot() 相同（测试守住两者一致）。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineJsonModule } from "./lib/inline-json.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "https://models.dev/api.json";
const TIMEOUT_MS = 60_000;
const REMOVAL_THRESHOLD = 0.3;

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "--help") flags.add(arg.slice(2));
    else if (arg.startsWith("--") && i + 1 < argv.length) values.set(arg.slice(2), argv[++i]);
    else throw new Error(`未知参数：${arg}`);
  }
  return { values, flags };
}

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const nonNegative = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function strings(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === "string") : undefined;
}

function prices(raw) {
  if (!isRecord(raw)) return undefined;
  const out = {};
  for (const key of ["input", "output", "cache_read", "cache_write"]) {
    const v = nonNegative(raw[key]);
    if (v !== undefined) out[key] = v;
  }
  return out.input !== undefined && out.output !== undefined ? out : undefined;
}

/**
 * 单个模型：过滤掉的返回 undefined（deprecated、输出不含文本、上下文为 0 / 缺失、tool_call:false）。
 * 为控制 bundle 体积（≤ 200 KB）不留 last_updated、reasoning_options 与 tool_call（过滤后恒为可用）。
 */
export function trimModel(raw) {
  if (!isRecord(raw)) return undefined;
  if (raw.status === "deprecated" || raw.tool_call === false) return undefined;
  const modalities = isRecord(raw.modalities) ? raw.modalities : {};
  const output = strings(modalities.output);
  if (output !== undefined && !output.includes("text")) return undefined;
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const context = positive(limit.context);
  if (context === undefined) return undefined;
  const out = {};
  for (const key of ["name", "family", "knowledge", "release_date"]) {
    if (typeof raw[key] === "string" && raw[key] !== "") out[key] = raw[key];
  }
  if (typeof raw.reasoning === "boolean") out.reasoning = raw.reasoning;
  if (typeof raw.canonical_model_id === "string") out.canonical_model_id = raw.canonical_model_id;
  if (raw.status === "beta") out.status = "beta";
  const input = strings(modalities.input);
  if (input !== undefined) out.modalities = { input };
  out.limit = { context };
  const inputLimit = positive(limit.input);
  if (inputLimit !== undefined) out.limit.input = inputLimit;
  const outputLimit = positive(limit.output);
  if (outputLimit !== undefined) out.limit.output = outputLimit;
  const cost = prices(raw.cost);
  if (cost !== undefined) {
    const over = prices(raw.cost.context_over_200k);
    if (over !== undefined) cost.context_over_200k = over;
    if (Array.isArray(raw.cost.tiers)) {
      const tiers = [];
      for (const tier of raw.cost.tiers) {
        const p = prices(tier);
        const size = isRecord(tier?.tier) ? positive(tier.tier.size) : undefined;
        if (p !== undefined && size !== undefined && tier.tier.type === "context")
          tiers.push({ ...p, tier: { size, type: "context" } });
      }
      if (tiers.length > 0) cost.tiers = tiers;
    }
    out.cost = cost;
  }
  if (raw.interleaved === true) out.interleaved = true;
  else if (isRecord(raw.interleaved) && typeof raw.interleaved.field === "string")
    out.interleaved = { field: raw.interleaved.field };
  return out;
}

/** 一家供应商：`{ id, name?, api?, models }`；prefixes 给出时只留以这些 `<前缀>/` 开头的模型。 */
export function trimProvider(id, raw, prefixes) {
  const out = { id, models: {} };
  if (typeof raw.name === "string") out.name = raw.name;
  if (typeof raw.api === "string") out.api = raw.api;
  const models = isRecord(raw.models) ? raw.models : {};
  for (const modelId of Object.keys(models).sort()) {
    if (prefixes !== undefined && !prefixes.some((p) => modelId.startsWith(`${p}/`))) continue;
    const model = trimModel(models[modelId]);
    if (model !== undefined) out.models[modelId] = model;
  }
  return out;
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

export function canonical(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function costText(cost) {
  if (cost === undefined) return "无";
  return `${cost.input}/${cost.output}/${cost.cache_read ?? "-"}/${cost.cache_write ?? "-"}`;
}

/** 新旧快照对比 → { added, removed, changed, before, after }。 */
export function diff(oldProviders, newProviders) {
  const flat = (providers) => {
    const map = new Map();
    for (const [id, p] of Object.entries(providers))
      for (const [m, model] of Object.entries(p?.models ?? {})) map.set(`${id}/${m}`, model);
    return map;
  };
  const before = flat(oldProviders);
  const after = flat(newProviders);
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed = [];
  for (const [ref, next] of after) {
    const prev = before.get(ref);
    if (prev === undefined) continue;
    const parts = [];
    for (const key of ["context", "output"]) {
      if (prev.limit?.[key] !== next.limit?.[key])
        parts.push(`${key} ${prev.limit?.[key] ?? "无"} → ${next.limit?.[key] ?? "无"}`);
    }
    if (costText(prev.cost) !== costText(next.cost))
      parts.push(`cost ${costText(prev.cost)} → ${costText(next.cost)}`);
    if (parts.length > 0) changed.push(`${ref}：${parts.join("；")}`);
  }
  changed.sort();
  return { added, removed, changed, before: before.size, after: after.size };
}

function summary(d, meta, changedFiles) {
  const lines = [
    "## models.dev 快照刷新",
    "",
    `来源 ${meta.source}（MIT，${meta.upstream}），sha256 \`${meta.sha256.slice(0, 12)}\`。`,
    "",
    `模型 ${d.before} → ${d.after}：新增 ${d.added.length}、删除 ${d.removed.length}、` +
      `上下文 / 输出 / 价格变化 ${d.changed.length}；改动文件 ${changedFiles.length} 个。`,
  ];
  const section = (title, items) => {
    if (items.length === 0) return;
    lines.push("", `### ${title}（${items.length}）`, "", ...items.map((i) => `- ${i}`));
  };
  section("新增", d.added);
  section("删除", d.removed);
  section("变化（价格为 input/output/cache_read/cache_write，$/1M）", d.changed);
  if (changedFiles.length === 0) lines.push("", "无变化。");
  return `${lines.join("\n")}\n`;
}

async function load(values) {
  const input = values.get("input");
  if (input !== undefined) return JSON.parse(readFileSync(resolve(input), "utf8"));
  const url = values.get("url") ?? process.env.AMA_MODELS_DEV_URL ?? DEFAULT_URL;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url}：HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    process.stdout.write(
      `${readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 13)
        .join("\n")}\n`,
    );
    return 0;
  }
  const out = resolve(values.get("out") ?? join(root, "src", "ai", "providers", "models-dev"));
  const dataOut = resolve(values.get("data-out") ?? join(dirname(out), "models-dev-data.ts"));
  const listPath = resolve(values.get("list") ?? join(out, "_providers.json"));
  const minProviders = Number(values.get("min-providers") ?? 100);
  const list = readJson(listPath);
  if (!isRecord(list) || !Array.isArray(list.providers)) throw new Error(`清单不可用：${listPath}`);

  const raw = await load(values);
  if (!isRecord(raw)) throw new Error("api.json 顶层不是对象");
  const count = Object.keys(raw).length;
  if (count <= minProviders)
    throw new Error(`api.json 只有 ${count} 家供应商（应 > ${minProviders}）`);

  const providers = {};
  for (const id of list.providers) {
    if (!isRecord(raw[id])) throw new Error(`api.json 缺少供应商 ${id}`);
    const prefixes =
      isRecord(list.prefixes) && Array.isArray(list.prefixes[id]) ? list.prefixes[id] : undefined;
    const provider = trimProvider(id, raw[id], prefixes);
    if (Object.keys(provider.models).length === 0) throw new Error(`${id} 过滤后没有模型`);
    providers[id] = provider;
  }

  const files = new Map();
  for (const id of list.providers) files.set(`${id}.json`, canonical(providers[id]));
  const hash = createHash("sha256");
  for (const text of files.values()) hash.update(text);
  const sha256 = hash.digest("hex");
  const previousMeta = readJson(join(out, "_meta.json"));
  const fetchedAt =
    previousMeta?.sha256 === sha256 && typeof previousMeta.fetchedAt === "string"
      ? previousMeta.fetchedAt
      : (values.get("now") ?? new Date().toISOString());
  const meta = {
    fetchedAt,
    license: "MIT",
    sha256,
    source: values.get("url") ?? DEFAULT_URL,
    upstream: "anomalyco/models.dev",
  };
  files.set("_meta.json", canonical(meta));

  const oldProviders = {};
  for (const id of list.providers) oldProviders[id] = readJson(join(out, `${id}.json`));
  const d = diff(oldProviders, providers);

  const entries = [
    ["_meta", meta],
    ["_providers", sortKeys(list)],
    ...list.providers.map((id) => [id, sortKeys(providers[id])]),
  ];
  const data = inlineJsonModule({
    header: [
      "由 scripts/update-models-dev.mjs 生成，勿手改（docs/guides/providers.md「模型元数据」）。",
      "",
      `数据来自 models.dev（${meta.source}，github.com/${meta.upstream}），MIT 许可：`,
      "Copyright (c) 2025 models.dev。完整声明见 THIRD_PARTY_NOTICES.md。",
    ],
    exportName: "MODELS_DEV_SOURCES",
    entries,
  });

  const changedFiles = [];
  for (const [name, text] of files) {
    const path = join(out, name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) changedFiles.push(path);
  }
  if (!existsSync(dataOut) || readFileSync(dataOut, "utf8") !== data) changedFiles.push(dataOut);

  if (!flags.has("dry-run")) {
    mkdirSync(out, { recursive: true });
    for (const [name, text] of files) {
      const path = join(out, name);
      if (changedFiles.includes(path)) writeFileSync(path, text);
    }
    if (changedFiles.includes(dataOut)) writeFileSync(dataOut, data);
  }
  process.stdout.write(summary(d, meta, changedFiles));
  return d.before > 0 && d.removed.length / d.before > REMOVAL_THRESHOLD ? 3 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(
        `update-models-dev: ${error instanceof Error ? error.message : error}\n`,
      );
      process.exit(1);
    },
  );
}
