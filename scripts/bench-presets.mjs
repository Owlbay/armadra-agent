#!/usr/bin/env node
/**
 * 三预设基准（第三波 §2.4）：default / minimal / codemode × 模型 × 任务，本地跑真实模型（CI 不跑）。
 *
 *   node scripts/bench-presets.mjs --config /tmp/ama-real/config.json \
 *     --models packy/kimi-k2.5,packy/MiniMax-M2.7,packy/deepseek-v4-flash \
 *     --presets default,minimal,codemode --tasks fix-bug,search-summarize,multi-file-refactor \
 *     --runs 1 --max-requests 120 --budget-usd 3 --per-run 10 --out docs/benchmarks/presets-2026-10-02.md
 *
 * 每次运行：任务仓库（test/fixtures/bench/<task>/repo）复制到临时目录，临时 AMA_CONFIG_DIR 里放
 * `--config` 的副本，经 SDK `createRuntime`（与 `ama -p` 同一启动序列，`full-auto` 权限、
 * `--tools-preset <preset>`）发一次 prompt，跑完用 `check.mjs` 判定。记录请求数（= 模型轮数）、
 * 工具调用数、累计 input + cacheRead、cacheWrite、output、估价、墙钟、成功与否。
 *
 * 成本控制（§3.7）：ApiRegistry 包装计数，超过 `--max-requests` / `--budget-usd` 立即停止并输出
 * 已有数据；`--per-run` 限制单次运行（超出算失败，继续下一组）。`--json <file>` 另存原始数据，
 * `--render <json> [--out <md>]` 由原始数据重出报告（不发请求）。
 * 用 fake 验证管线：`--models fake/echo`（不花钱，任务必然失败）。
 *
 * [W5-H2] D20 对照组：`default+todo`（config `tools.default: ["+todo"]`）对 `default-todo`（不含 todo）。
 * 两组都在时报告多一节「D20 判定」：todo 组费用（统一估价）涨幅 > 5% 或成功率下降 → 撤出 default。
 * [W5-Z] 0.5.0 起 `default` 预设不含 todo（复测未过门），`default` 与 `default-todo` 相同。0.5.0 之前
 * 跑出的原始数据（`meta.defaultHasTodo` 缺省）里 `default` 含 todo，`--render` 按当时的含义归组。
 *
 *   node scripts/bench-presets.mjs --config <cfg> --models packy/kimi-k2.5,packy/deepseek-v4-flash \
 *     --presets default,default-todo --max-requests 60 --budget-usd 2 --per-run 8 \
 *     --out docs/benchmarks/presets-todo-<date>.md --json docs/benchmarks/presets-todo-<date>.json
 *
 * [W5-Z] D20 复测用多步长任务：`--tasks long`（multi-bug-hunt、string-kit、inventory-feature），
 * `--runs 3 --per-run 25`。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  REPORT_PRICE,
  ROOT,
  RealBudget,
  fmt,
  loadDist,
  makeSandbox,
  priceUsage,
  realSettings,
  table,
} from "./real-budget.mjs";

const TASKS_DIR = join(ROOT, "test", "fixtures", "bench");
export const PRESETS = ["default", "minimal", "codemode"];

/** 基准里的「预设」名 → 实际 `--tools-preset` 与额外配置（对照组）。 */
export const PRESET_VARIANTS = {
  "default+todo": { preset: "default", extra: { tools: { default: ["+todo"] } } },
  "default-todo": { preset: "default", extra: { tools: { default: ["-todo"] } } },
};

/** 这个基准「预设」名的工具表里有没有 todo（`defaultHasTodo`：当时的 `default` 预设是否含 todo）。 */
export function variantHasTodo(name, defaultHasTodo = false) {
  if (name === "default+todo") return true;
  if (name === "default-todo") return false;
  return name === "default" ? defaultHasTodo : undefined;
}

export function presetVariant(name) {
  return PRESET_VARIANTS[name] ?? { preset: name, extra: {} };
}

/** D20 的门：费用涨幅上限（todo 组相对对照组）。 */
export const D20_MAX_COST_INCREASE = 0.05;
export const TASKS = ["fix-bug", "search-summarize", "multi-file-refactor"];
/**
 * [W5-Z] 多步长任务（D20 复测）：每个需要 5+ 步、适合 todo 跟踪；不在缺省 `--tasks` 里，
 * `--tasks long` 选全部，或逐个列名。
 */
export const LONG_TASKS = ["multi-bug-hunt", "string-kit", "inventory-feature"];
export const ALL_TASKS = [...TASKS, ...LONG_TASKS];

/** `--tasks` 解析：逗号分隔，`long` 展开为全部长任务。 */
export function parseTasks(raw) {
  const tasks = raw
    .split(",")
    .filter(Boolean)
    .flatMap((t) => (t === "long" ? LONG_TASKS : [t]));
  for (const t of tasks) if (!ALL_TASKS.includes(t)) throw new Error(`未知任务 ${t}`);
  return tasks;
}

function sumUsage(entries) {
  const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const { usage } of entries) {
    for (const key of Object.keys(total)) total[key] += usage[key] ?? 0;
  }
  return total;
}

/** 跑一组（模型 × 预设 × 任务 × 第 n 次）。 */
async function runOne(dist, budget, settings, { model, preset, task, run }) {
  const label = `${model}·${preset}·${task}·${run}`;
  const variant = presetVariant(preset);
  const sandbox = makeSandbox({
    configPath: existsSync(settings.config) ? settings.config : undefined,
    repo: join(TASKS_DIR, task, "repo"),
    // 基准只比预设：缓存保温关掉（保温请求另算，见 cache-experiment）。
    extra: { cache: { warming: "off" }, ...variant.extra },
  });
  const prompt = readFileSync(join(TASKS_DIR, task, "prompt.md"), "utf8").trim();
  const check = (await import(pathToFileURL(join(TASKS_DIR, task, "check.mjs")).href)).default;
  budget.startRun(label);
  const apis = budget.wrap(dist.createDefaultApiRegistry(), dist);
  const started = Date.now();
  let toolCalls = 0;
  let nested = 0;
  let todoCalls = 0;
  let error;
  let runtime;
  try {
    runtime = await dist.createRuntime({
      cwd: sandbox.work,
      argv: ["--model", model, "--tools-preset", variant.preset],
      permissionMode: "full-auto",
      unattended: true,
      env: sandbox.env,
      stderr: () => undefined,
      compose: { apis },
    });
    runtime.session.subscribe((event) => {
      if (event.type !== "tool_execution_start") return;
      if (event.parentToolCallId === undefined) toolCalls++;
      else nested++;
      if (event.toolName === "todo") todoCalls++;
    });
    await runtime.session.prompt(prompt);
    const last = runtime.session.messages.at(-1);
    if (last?.role === "assistant" && last.stopReason === "error") error = last.errorMessage;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    await runtime?.dispose().catch(() => undefined);
  }
  const wallMs = Date.now() - started;
  const entries = budget.log.filter((e) => e.run === label);
  const usage = sumUsage(entries);
  let verdict;
  try {
    verdict = check(sandbox.work);
  } catch (e) {
    verdict = { ok: false, detail: `check 出错：${e.message}` };
  }
  sandbox.cleanup();
  const detail = verdict.ok ? verdict.detail : (error ?? verdict.detail);
  return {
    model,
    preset,
    task,
    run,
    // 全局上限触发的中止不算失败：不进汇总表，明细里标「中止」。
    aborted: !verdict.ok && /budget_exceeded: (请求数|预算)/.test(String(error ?? "")),
    requests: entries.length,
    toolCalls,
    nestedCalls: nested,
    todoCalls,
    usage,
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    estUsd: priceUsage(usage, REPORT_PRICE),
    budgetUsd: entries.reduce((s, e) => s + e.usd, 0),
    wallMs,
    ok: verdict.ok,
    detail,
  };
}

function aggregate(results, key) {
  const groups = new Map();
  for (const r of results) {
    if (r.aborted) continue;
    const id = key(r);
    const g = groups.get(id) ?? { n: 0, ok: 0, requests: 0, prompt: 0, est: 0, wall: 0 };
    g.n++;
    if (r.ok) g.ok++;
    g.requests += r.requests;
    g.prompt += r.promptTokens;
    g.est += r.estUsd;
    g.wall += r.wallMs;
    groups.set(id, g);
  }
  return groups;
}

export function renderReport(results, meta) {
  const out = [];
  out.push(`# 三预设基准（${meta.date}）`, "");
  out.push(
    `> 由 \`scripts/bench-presets.mjs\` 生成。模型：${meta.models.join("、")}；预设：${meta.presets.join("、")}；` +
      `任务：${meta.tasks.join("、")}；每组 ${meta.runs} 次。`,
  );
  out.push(
    `> 请求 ${meta.requests} 次（上限 ${meta.maxRequests}），预算计价 $${meta.usd.toFixed(3)}（上限 $${meta.budgetUsd}）` +
      `${meta.stopped ? `；**提前停止：${meta.stopped}**` : ""}。`,
  );
  out.push(
    "> 「估价」按统一价 input / cacheWrite 1、cacheRead 0.1、output 4 美元每 M 计，跨模型可比，不是真实账单；" +
      "「输入」= input + cacheRead + cacheWrite（模型实际读入的 token）。保温关闭。" +
      "达到全局上限而中止的运行标「中止」，不进汇总。",
    "",
  );
  out.push("## 按预设 × 任务", "");
  const byPT = aggregate(results, (r) => `${r.preset}\u0000${r.task}`);
  out.push(
    table(
      ["预设", "任务", "成功", "平均轮数", "平均输入", "平均估价", "平均墙钟"],
      [...byPT].map(([id, g]) => {
        const [preset, task] = id.split("\u0000");
        return [
          preset,
          task,
          `${g.ok}/${g.n}`,
          (g.requests / g.n).toFixed(1),
          fmt.k(Math.round(g.prompt / g.n)),
          fmt.usd(g.est / g.n),
          fmt.s(g.wall / g.n),
        ];
      }),
    ),
    "",
  );
  out.push("## 按预设合计", "");
  const byP = aggregate(results, (r) => r.preset);
  out.push(
    table(
      ["预设", "成功", "轮数合计", "输入合计", "估价合计", "墙钟合计"],
      [...byP].map(([preset, g]) => [
        preset,
        `${g.ok}/${g.n}`,
        String(g.requests),
        fmt.k(g.prompt),
        fmt.usd(g.est),
        fmt.s(g.wall),
      ]),
    ),
    "",
  );
  const d20 = renderD20(results, meta);
  if (d20.length > 0) out.push(...d20);
  out.push("## 明细", "");
  out.push(
    table(
      [
        "模型",
        "预设",
        "任务",
        "成功",
        "轮数",
        "工具（内层）",
        "输入",
        "其中缓存读",
        "写入",
        "输出",
        "估价",
        "墙钟",
        "说明",
      ],
      results.map((r) => [
        r.model,
        r.preset,
        r.task,
        r.ok ? "✓" : r.aborted ? "中止" : "✗",
        String(r.requests),
        `${r.toolCalls}${r.nestedCalls ? `（${r.nestedCalls}）` : ""}`,
        fmt.k(r.promptTokens),
        fmt.k(r.usage.cacheRead),
        fmt.k(r.usage.cacheWrite),
        fmt.k(r.usage.output),
        fmt.usd(r.estUsd),
        fmt.s(r.wallMs),
        String(r.detail ?? "")
          .replace(/\|/g, "\\|")
          .slice(0, 80),
      ]),
    ),
    "",
  );
  return out.join("\n");
}

/**
 * D20 判定：只比两组都跑完（都没中止）的「模型 × 任务 × 第 n 次」配对；费用用统一估价。
 * 返回报告行（两组不全时为空）。
 */
export function d20Verdict(results, { defaultHasTodo = false } = {}) {
  const key = (r) => `${r.model}\u0000${r.task}\u0000${r.run}`;
  const control = new Map();
  for (const r of results)
    if (!r.aborted && variantHasTodo(r.preset, defaultHasTodo) === false) control.set(key(r), r);
  const pairs = [];
  for (const r of results) {
    if (r.aborted || variantHasTodo(r.preset, defaultHasTodo) !== true) continue;
    const c = control.get(key(r));
    if (c !== undefined) pairs.push([r, c]);
  }
  if (pairs.length === 0) return undefined;
  const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);
  const withTodo = pairs.map(([t]) => t);
  const without = pairs.map(([, c]) => c);
  const group = (rows) => ({
    n: rows.length,
    ok: rows.filter((r) => r.ok).length,
    requests: sum(rows, (r) => r.requests),
    prompt: sum(rows, (r) => r.promptTokens),
    est: sum(rows, (r) => r.estUsd),
    spent: sum(rows, (r) => r.budgetUsd ?? 0),
    todoCalls: sum(rows, (r) => r.todoCalls ?? 0),
  });
  const t = group(withTodo);
  const c = group(without);
  const costIncrease = c.est > 0 ? t.est / c.est - 1 : 0;
  const spentIncrease = c.spent > 0 ? t.spent / c.spent - 1 : 0;
  const inputIncrease = c.prompt > 0 ? t.prompt / c.prompt - 1 : 0;
  const successDrop = t.ok < c.ok;
  const keep = costIncrease <= D20_MAX_COST_INCREASE && !successDrop;
  return {
    pairs: pairs.length,
    withTodo: t,
    control: c,
    costIncrease,
    spentIncrease,
    inputIncrease,
    successDrop,
    keep,
  };
}

function renderD20(results, meta) {
  const v = d20Verdict(results, { defaultHasTodo: meta.defaultHasTodo ?? true });
  if (v === undefined) return [];
  const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const row = (name, g) => [
    name,
    `${g.ok}/${g.n}`,
    String(g.requests),
    fmt.k(g.prompt),
    fmt.usd(g.est),
    `$${g.spent.toFixed(3)}`,
    String(g.todoCalls),
  ];
  return [
    "## D20 判定（todo 是否留在 default）",
    "",
    `> 只比两组都跑完的 ${v.pairs} 对（同模型 × 任务 × 次）。门：todo 组估价涨幅 ≤ ${D20_MAX_COST_INCREASE * 100}% 且成功数不降。`,
    "",
    table(
      ["组", "成功", "请求", "输入", "估价", "预算计价", "todo 调用"],
      [row("含 todo", v.withTodo), row("不含 todo（对照）", v.control)],
    ),
    "",
    `估价涨幅 ${pct(v.costIncrease)}（门用这一列：与缓存同口径）；输入 token ${pct(v.inputIncrease)}、` +
      `保守计价（缓存读也按全价）${pct(v.spentIncrease)}；成功数${v.successDrop ? "下降" : "未降"} → ` +
      `**${v.keep ? "保留 todo 在 default" : "撤出 default（退回 [DONE:n] 文本交接）"}**。`,
    "",
  ];
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      models: { type: "string" },
      presets: { type: "string", default: PRESETS.join(",") },
      tasks: { type: "string", default: TASKS.join(",") },
      runs: { type: "string", default: "1" },
      "max-requests": { type: "string" },
      "budget-usd": { type: "string" },
      "per-run": { type: "string", default: "12" },
      out: { type: "string" },
      json: { type: "string" },
      render: { type: "string" },
    },
  });
  if (values.render) {
    const { meta, results } = JSON.parse(readFileSync(values.render, "utf8"));
    for (const r of results)
      r.aborted ??= !r.ok && /budget_exceeded: (请求数|预算)/.test(String(r.detail ?? ""));
    const report = renderReport(results, meta);
    if (values.out) writeFileSync(values.out, `${report}\n`);
    else process.stdout.write(`${report}\n`);
    return;
  }
  const settings = realSettings(values);
  if (settings.models.length === 0) throw new Error("--models / AMA_REAL_MODELS 为空");
  const fakeOnly = settings.models.every((m) => m.startsWith("fake/"));
  if (!fakeOnly && !existsSync(settings.config)) throw new Error(`配置不存在：${settings.config}`);
  const presets = values.presets.split(",").filter(Boolean);
  const tasks = parseTasks(values.tasks);
  const known = [...PRESETS, ...Object.keys(PRESET_VARIANTS)];
  for (const p of presets) if (!known.includes(p)) throw new Error(`未知预设 ${p}`);
  const runs = Number(values.runs);
  const dist = await loadDist();
  const budget = new RealBudget({
    maxRequests: settings.maxRequests,
    budgetUsd: settings.budgetUsd,
    perRunMax: Number(values["per-run"]),
  });
  const results = [];
  // 任务在外层：预算耗尽时，已跑完的任务在所有模型 / 预设上是完整的。
  outer: for (const task of tasks) {
    for (let run = 1; run <= runs; run++) {
      for (const model of settings.models) {
        for (const preset of presets) {
          const blocked = budget.blocker();
          if (blocked !== undefined && !blocked.startsWith("单次")) {
            budget.stopped ??= blocked;
            break outer;
          }
          const r = await runOne(dist, budget, settings, { model, preset, task, run });
          results.push(r);
          process.stderr.write(
            `bench: ${r.ok ? "✓" : "✗"} ${model} ${preset} ${task} · ${r.requests} 轮 · ` +
              `${fmt.k(r.promptTokens)} 输入 · ${fmt.s(r.wallMs)}（累计 ${budget.requests} 请求 $${budget.usd.toFixed(3)}）\n`,
          );
          if (budget.stopped) break outer;
        }
      }
    }
  }
  const meta = {
    date: new Date().toISOString().slice(0, 10),
    models: settings.models,
    presets,
    tasks,
    runs,
    requests: budget.requests,
    maxRequests: settings.maxRequests,
    usd: budget.usd,
    budgetUsd: settings.budgetUsd,
    stopped: budget.stopped,
    defaultHasTodo: false,
  };
  const report = renderReport(results, meta);
  if (values.out) writeFileSync(values.out, `${report}\n`);
  else process.stdout.write(`${report}\n`);
  if (values.json) writeFileSync(values.json, JSON.stringify({ meta, results }, null, 2));
  if (budget.stopped) process.stderr.write(`bench: 提前停止：${budget.stopped}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`bench-presets: ${error.message}\n`);
    process.exit(1);
  });
}
