/**
 * 真实模型脚本的公共部分（第三波 §3.7）：`bench-presets.mjs` 与 `cache-experiment.mjs` 共用。
 *
 * - 加载构建产物 `dist/`（先 `pnpm build`）；
 * - `RealBudget.wrap(registry)`：包装 ApiRegistry 的每条协议，在 `stream()` 处计数并按 usage 累计
 *   费用；超过请求上限或预算时不再发请求，直接返回一个 `budget_exceeded` 错误流，让当前运行以
 *   错误结束（脚本随后停止并输出已有数据）；
 * - 计价：模型有目录价用目录价（`usage.cost.total`）；无价按 input / cacheWrite / cacheRead
 *   1 美元每 M、output 4 美元每 M **保守**估（预算用）；
 * - 临时工作区与配置目录（`AMA_CONFIG_DIR` / `AMA_DATA_DIR` 指向临时目录，不碰用户配置）。
 *
 * 环境变量：AMA_REAL_CONFIG（config.json 路径）、AMA_REAL_MODELS、AMA_REAL_MAX_REQUESTS
 * （缺省 60）、AMA_REAL_BUDGET_USD（缺省 3）。命令行参数优先。CI 永不设置这些变量。
 */

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `dir` 缺省本仓库 `dist/`；对照实验可指向另一份构建（例如改进前的提交）。 */
export async function loadDist(dir = join(ROOT, "dist")) {
  const dist = (path) => import(pathToFileURL(join(dir, path)).href);
  try {
    const [index, api, stream, shared] = await Promise.all([
      dist("index.js"),
      dist("ai/apis/api.js"),
      dist("ai/event-stream.js"),
      dist("ai/apis/shared.js"),
    ]);
    return {
      createRuntime: index.createRuntime,
      createDefaultApiRegistry: api.createDefaultApiRegistry,
      AssistantEventStreamImpl: stream.AssistantEventStreamImpl,
      createOutput: shared.createOutput,
    };
  } catch (error) {
    throw new Error(`${dir} 不可用，先 pnpm build（${error.message}）`);
  }
}

/** 无目录价时的保守估价（美元每 M token）。 */
export const FALLBACK_PRICE = { input: 1, cacheRead: 1, cacheWrite: 1, output: 4 };
/** 报告用的统一估价（缓存读按 1/10）：跨模型可比，不是真实账单。 */
export const REPORT_PRICE = { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 4 };

export function priceUsage(usage, price) {
  return (
    (usage.input * price.input +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite +
      usage.output * price.output) /
    1e6
  );
}

/** 预算计价：目录价优先，缺价按保守估价。 */
export function budgetUsd(usage) {
  const total = usage.cost?.total;
  return typeof total === "number" && total > 0 ? total : priceUsage(usage, FALLBACK_PRICE);
}

export class RealBudget {
  /** @param {{ maxRequests: number, budgetUsd: number, perRunMax?: number }} limits */
  constructor(limits) {
    this.limits = limits;
    this.requests = 0;
    this.usd = 0;
    this.stopped = undefined;
    /** 每次真实请求一条：{ run, purpose, model, usage, usd }。 */
    this.log = [];
    this.run = undefined;
    this.runRequests = 0;
  }

  /** 开始一次运行（单次运行另有请求上限 perRunMax）。 */
  startRun(label) {
    this.run = label;
    this.runRequests = 0;
  }

  /** 超限原因；undefined = 还能发。 */
  blocker() {
    if (this.requests >= this.limits.maxRequests)
      return `请求数达到上限 ${this.limits.maxRequests}`;
    if (this.usd >= this.limits.budgetUsd)
      return `预算达到上限 $${this.limits.budgetUsd}（已用 $${this.usd.toFixed(3)}）`;
    if (this.limits.perRunMax !== undefined && this.runRequests >= this.limits.perRunMax)
      return `单次运行请求数达到上限 ${this.limits.perRunMax}`;
    return undefined;
  }

  /** 包装注册表里的每条协议（含 detectCompat）。 */
  wrap(registry, dist) {
    for (const id of registry.ids()) {
      const inner = registry.get(id);
      const budget = this;
      const wrapped = {
        id,
        stream(model, context, options) {
          const blocked = budget.blocker();
          if (blocked !== undefined) {
            const global = !blocked.startsWith("单次");
            if (global) budget.stopped ??= blocked;
            return errorStream(dist, model, `budget_exceeded: ${blocked}`);
          }
          budget.requests++;
          budget.runRequests++;
          const run = budget.run;
          const stream = inner.stream(model, context, options);
          void stream.result().then((message) => {
            const usd = budgetUsd(message.usage);
            budget.usd += usd;
            budget.log.push({
              run,
              purpose: options.purpose ?? "turn",
              messages: context.messages.length,
              toolChoice: options.toolChoice,
              model: `${model.provider}/${model.id}`,
              stopReason: message.stopReason,
              usage: message.usage,
              usd,
            });
          });
          return stream;
        },
      };
      if (inner.detectCompat) wrapped.detectCompat = inner.detectCompat.bind(inner);
      registry.register(wrapped);
    }
    return registry;
  }
}

function errorStream(dist, model, text) {
  const stream = new dist.AssistantEventStreamImpl();
  const message = dist.createOutput(model);
  message.stopReason = "error";
  message.errorMessage = text;
  stream.push({ type: "error", reason: "error", message });
  stream.end();
  return stream;
}

/** 命令行 `--max-requests` / `--budget-usd` / `--config` / `--models` 与 AMA_REAL_* 合并。 */
export function realSettings(values) {
  const env = process.env;
  const number = (flag, name, fallback) => {
    const raw = flag ?? env[name];
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} 不是正数：${raw}`);
    return parsed;
  };
  const list = (raw) =>
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    config:
      values.config ??
      env.AMA_REAL_CONFIG ??
      join(env.AMA_CONFIG_DIR ?? join(homedir(), ".config", "ama"), "config.json"),
    models: list(values.models ?? env.AMA_REAL_MODELS),
    maxRequests: number(values["max-requests"], "AMA_REAL_MAX_REQUESTS", 60),
    budgetUsd: number(values["budget-usd"], "AMA_REAL_BUDGET_USD", 3),
  };
}

/**
 * 临时沙箱：`work/`（任务仓库副本）+ `config/config.json`（真实配置——`configPath` 或现成对象
 * `config`——合并 `extra`）+ `data/`。
 * 返回 env（AMA_CONFIG_DIR / AMA_DATA_DIR 指向沙箱）与清理函数。
 */
export function makeSandbox({ configPath, config, extra = {}, repo }) {
  const root = mkdtempSync(join(tmpdir(), "ama-real-"));
  const work = join(root, "work");
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  for (const dir of [work, configDir, dataDir]) mkdirSync(dir, { recursive: true });
  if (repo) cpSync(repo, work, { recursive: true });
  let base = config ?? { version: 1 };
  if (configPath) base = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(join(configDir, "config.json"), JSON.stringify(deepMerge(base, extra), null, 2));
  return {
    root,
    work,
    env: {
      ...process.env,
      AMA_CONFIG_DIR: configDir,
      AMA_DATA_DIR: dataDir,
      AMA_NO_LOCAL_PROBE: "1",
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function deepMerge(base, extra) {
  if (Array.isArray(extra) || typeof extra !== "object" || extra === null) return extra;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const prev = out[key];
    out[key] =
      typeof prev === "object" && prev !== null && !Array.isArray(prev)
        ? deepMerge(prev, value)
        : value;
  }
  return out;
}

/** 等宽 Markdown 表。 */
export function table(headers, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

export const fmt = {
  k: (n) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)),
  usd: (n) => (n === undefined ? "$?" : `$${n.toFixed(4)}`),
  pct: (n) => (n === undefined ? "—" : `${(n * 100).toFixed(0)}%`),
  s: (ms) => `${(ms / 1000).toFixed(1)}s`,
};
