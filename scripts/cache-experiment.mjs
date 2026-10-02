#!/usr/bin/env node
/**
 * 缓存验收实验 E1–E5（第三波 §1.13），本地跑真实中转（CI 不跑）。
 *
 *   node scripts/cache-experiment.mjs --config /tmp/ama-real/config.json --case E1,E4,E5 \
 *     --models packy/kimi-k2.5,packy/MiniMax-M2.7,packy/deepseek-v4-flash --max-requests 50 \
 *     --json /tmp/cache.json
 *   node scripts/cache-experiment.mjs --case E2 --model packy/kimi-k2.5 --warming off --json /tmp/cache.json
 *   node scripts/cache-experiment.mjs --case E3 --model packy/kimi-k2.5 --dist /tmp/ama-old/dist \
 *     --label 改进前 --json /tmp/cache.json
 *   node scripts/cache-experiment.mjs --render /tmp/cache.json --out docs/benchmarks/cache-2026-10-02.md
 *
 * 每个用例经 SDK `createRuntime` 起一个会话（临时 AMA_CONFIG_DIR 放 `--config` 副本），ApiRegistry
 * 包装记录每次请求的用途（turn / summary / warm / probe）与 usage，会话事件记 `cache_miss` /
 * `cache_warm`，结束时取 `getStats().cache`。结果追加进 `--json`（同一文件可多次运行累积），
 * `--render` 把它写成报告。`--dist` 换成另一份构建（例如改进前的提交）做对照。`--e1 … --e5`
 * 给单个用例换模型列表（例如 `--case E1,E4,E5 --e4 packy/kimi-k2.5`，同一进程共享三态）；
 * `--seed <models>` 先对这些模型各发两句短问答把三态预热成 reported。
 *
 * | 用例 | 做法 |
 * | --- | --- |
 * | E1 | fix-bug 仓库上 5 轮（read → read → edit → bash → 总结），每个模型一个会话 |
 * | E2 | 模型填 promptCache.short（`--ttl`，缺省 300 s，用户自填）、保温 `--warming`；一轮 `sleep 420` 后再问一句 |
 * | E3 | 读 4 个约 48 KB 的文件累积前缀后 `compact()`，比较摘要请求的 usage |
 * | E4 | AGENTS.md 垫大前缀（`--e4-pad` 字符）；3 轮后切到 `--switch-to` 模型再切回；宿主中途注册工具；再停用一个内置工具 |
 * | E5 | 4 轮问答看三态（silent）+ 内联 cache-probe（同一 2k 前缀发两次） |
 *
 * 成本控制同 bench-presets（§3.7）：超过 `--max-requests` / `--budget-usd` 停止并输出已有数据。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ROOT,
  RealBudget,
  deepMerge,
  fmt,
  loadDist,
  makeSandbox,
  realSettings,
  table,
} from "./real-budget.mjs";

const FIX_BUG = join(ROOT, "test", "fixtures", "bench", "fix-bug", "repo");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 给配置里 `provider/id` 的模型条目打补丁（models[] 或 modelOverrides[]）。 */
export function patchModel(config, ref, patch) {
  const [provider, id] = ref.split("/");
  const p = (config.providers ??= {})[provider] ?? (config.providers[provider] = {});
  const entry = (p.models ?? []).find((m) => m.id === id);
  if (entry) Object.assign(entry, deepMerge(entry, patch));
  else (p.modelOverrides ??= []).push({ id, ...patch });
  return config;
}

/** 约 48 KB 的确定性文本（read 工具单次上限 50 KB）。 */
function bigText(tag) {
  const lines = [];
  for (let i = 1; lines.join("\n").length < 48_000; i++) {
    lines.push(
      `${tag} line ${i}: the archive entry ${i * 13} records batch ${i % 97} at offset ${i * 4096}.`,
    );
  }
  return lines.join("\n");
}

class Session {
  /** @param {{ dist, budget, settings, model, extra?, repo?, files?, argv?, label }} o */
  static async open(o) {
    const s = new Session();
    let config = existsSync(o.settings.config)
      ? JSON.parse(readFileSync(o.settings.config, "utf8"))
      : { version: 1 };
    if (o.patch) config = o.patch(config);
    s.sandbox = makeSandbox({ config, repo: o.repo ?? FIX_BUG, extra: o.extra ?? {} });
    for (const [name, text] of Object.entries(o.files ?? {}))
      writeFileSync(join(s.sandbox.work, name), text);
    s.budget = o.budget;
    s.label = o.label;
    s.events = [];
    s.phase = "turn";
    s.apis = o.budget.wrap(o.dist.createDefaultApiRegistry(), o.dist);
    o.budget.startRun(o.label);
    s.runtime = await o.dist.createRuntime({
      cwd: s.sandbox.work,
      argv: ["--model", o.model, ...(o.argv ?? [])],
      permissionMode: "full-auto",
      unattended: true,
      env: s.sandbox.env,
      stderr: () => undefined,
      compose: { apis: s.apis },
    });
    s.runtime.session.subscribe((event) => {
      if (["cache_miss", "cache_warm", "context_pressure"].includes(event.type))
        s.events.push({ at: s.requests().length, ...event });
    });
    return s;
  }

  requests() {
    return this.budget.log.filter((e) => e.run === this.label);
  }

  async prompt(text) {
    await this.runtime.session.prompt(text);
  }

  async close() {
    const stats = this.runtime.session.getStats();
    await this.runtime.dispose().catch(() => undefined);
    this.sandbox.cleanup();
    return stats;
  }
}

function summarizeRequests(entries) {
  return entries.map((e) => ({
    purpose: e.purpose,
    model: e.model,
    messages: e.messages,
    toolChoice: e.toolChoice,
    input: e.usage.input,
    cacheRead: e.usage.cacheRead,
    cacheWrite: e.usage.cacheWrite,
    output: e.usage.output,
    prompt: e.usage.input + e.usage.cacheRead + e.usage.cacheWrite,
    stopReason: e.stopReason,
  }));
}

const E1_PROMPTS = [
  "Read src/stats.js with the read tool and tell me in one sentence what median does.",
  "Now read test.js and tell me which assertion fails.",
  "Fix the bug in src/stats.js with the edit tool (do not touch test.js).",
  "Run `node test.js` with the bash tool and tell me its output.",
  "Summarize what you changed in one sentence.",
];

async function caseE1(ctx, model) {
  const s = await Session.open({ ...ctx, model, label: `E1 ${model}` });
  for (const text of E1_PROMPTS) {
    await s.prompt(text);
    if (ctx.budget.stopped) break;
  }
  const requests = summarizeRequests(s.requests());
  const events = s.events;
  return { case: "E1", model, requests, events, stats: (await s.close()).cache };
}

async function caseE2(ctx, model) {
  const warming = ctx.values.warming;
  const ttl = Number(ctx.values.ttl);
  const s = await Session.open({
    ...ctx,
    model,
    label: `E2 ${model} ${warming}`,
    // 用户自填：中转模型目录无 TTL，按 Kimi 名义 5 分钟填 promptCache.short；价格用于保温经济性。
    patch: (config) =>
      patchModel(config, model, {
        promptCache: { short: ttl },
        cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
      }),
    extra: { cache: { warming, minSavingsUsd: 0.0001 } },
  });
  await s.prompt("Reply with just: ready");
  const before = s.requests().length;
  await s.prompt(
    "Use the bash tool to run `sleep 420` with timeoutMs 600000. When it finishes, reply with just: done",
  );
  await s.prompt("Reply with just: ok");
  const requests = summarizeRequests(s.requests());
  return {
    case: "E2",
    model,
    warming,
    ttl,
    sleepStartIndex: before,
    requests,
    events: s.events,
    stats: (await s.close()).cache,
  };
}

async function caseE3(ctx, model) {
  const files = {};
  for (const n of [1, 2, 3, 4]) files[`part${n}.txt`] = bigText(`part${n}`);
  const s = await Session.open({ ...ctx, model, label: `E3 ${model} ${ctx.values.label}`, files });
  await s.prompt(
    "Read part1.txt and part2.txt with the read tool (in parallel) and reply with only the last line of each.",
  );
  await s.prompt(
    "Read part3.txt and part4.txt with the read tool (in parallel) and reply with only the last line of each.",
  );
  await s.prompt("Reply with just: ok");
  const mark = s.requests().length;
  let compaction;
  try {
    const result = await s.runtime.session.compact();
    compaction = { tokensBefore: result.tokensBefore, summaryChars: result.summary?.length };
  } catch (error) {
    compaction = { error: error.message };
  }
  const summaryRequests = s.requests().length - mark;
  if (!ctx.budget.stopped) await s.prompt("Reply with just: ok");
  return {
    case: "E3",
    model,
    label: ctx.values.label,
    compactAt: mark,
    summaryRequests,
    compaction,
    requests: summarizeRequests(s.requests()),
    events: s.events,
    stats: (await s.close()).cache,
  };
}

async function caseE4(ctx, model) {
  const key = "__amaCacheExperimentHost";
  const host = `module.exports = { hostApi: 1, create(api) { globalThis[${JSON.stringify(key)}] = api; return { id: "cache-experiment" }; } };`;
  // 项目规则垫大前缀：前缀低于 minTokens（缺省 1024）时按设计不判未命中（§1.5 第 1 条）。
  const pad = Number(ctx.values["e4-pad"]);
  const files = { "host.cjs": host };
  if (pad > 0) files["AGENTS.md"] = bigText("rule").slice(0, pad);
  const s = await Session.open({
    ...ctx,
    model,
    label: `E4 ${model} pad ${pad}`,
    files,
    argv: ["--host", "host.cjs"],
  });
  const steps = [];
  const turn = async (text, step) => {
    const from = s.events.length;
    await s.prompt(text);
    steps.push({ step, misses: s.events.slice(from).filter((e) => e.type === "cache_miss") });
  };
  for (const n of ["one", "two", "three"]) await turn(`Reply with just: ${n}`, `轮 ${n}`);
  await s.runtime.session.setModel(ctx.values["switch-to"]);
  await turn("Reply with just: four", `切到 ${ctx.values["switch-to"]}`);
  await s.runtime.session.setModel(model);
  await turn("Reply with just: five", `切回 ${model}`);
  globalThis[key].tools.register({
    name: "canvas_note",
    description: "Post a short note on the canvas.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    permission: "read",
    execute: async () => ({ content: "ok" }),
  });
  await turn("Reply with just: six", "宿主注册 canvas_note");
  const names = s.runtime.session.getTools().map((t) => t.name);
  s.runtime.session.setActiveTools(names.filter((n) => n !== "grep"));
  await turn("Reply with just: seven", "停用 grep");
  return {
    case: "E4",
    model,
    pad,
    steps,
    requests: summarizeRequests(s.requests()),
    events: s.events,
    stats: (await s.close()).cache,
  };
}

/** 内联 cache-probe（§1.11 同一做法）：约 2k token 的固定前缀发两次，判定 reported / silent / inconclusive。 */
async function probe(ctx, session, ref) {
  const runtime = session.runtime;
  const found = runtime.providers.findModel(ref);
  if (!found.ok) return { verdict: "error", detail: `找不到 ${ref}` };
  const { model, provider } = found;
  const key = await runtime.providers.resolveApiKey(provider.id);
  const lines = ["You are a terse assistant. Probe notes follow."];
  for (let i = 1; lines.join("\n").length < 8_400; i++)
    lines.push(`Probe note ${i}: value ${i * 31}.`);
  const context = {
    messages: [
      { role: "system", sections: { preamble: lines.join("\n") }, timestamp: 0 },
      { role: "user", content: "Reply with: ok", timestamp: 1 },
    ],
  };
  const api = session.apis.get(model.api);
  const shots = [];
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(3000);
    const message = await api
      .stream(model, context, {
        signal: new AbortController().signal,
        apiKey: key.apiKey,
        maxTokens: 16,
        cacheRetention: "short",
        purpose: "probe",
      })
      .result();
    const u = message.usage;
    shots.push({
      input: u.input,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      cacheReported: u.cacheReported,
      error: message.errorMessage,
    });
  }
  const [a, b] = shots;
  const firstLen = a.input + a.cacheRead + a.cacheWrite;
  const verdict =
    b.cacheRead > 0 ? (b.cacheRead < firstLen * 0.5 ? "inconclusive" : "reported") : "silent";
  return { verdict, shots };
}

async function caseE5(ctx, model) {
  const s = await Session.open({ ...ctx, model, label: `E5 ${model}` });
  const states = [];
  for (const n of ["one", "two", "three", "four"]) {
    await s.prompt(`Reply with just: ${n}`);
    states.push(s.runtime.session.getStats().cache?.reporting);
  }
  const probed = ctx.budget.stopped ? { verdict: "skipped" } : await probe(ctx, s, model);
  return {
    case: "E5",
    model,
    states,
    probe: probed,
    requests: summarizeRequests(s.requests()),
    events: s.events,
    stats: (await s.close()).cache,
  };
}

const CASES = { E1: caseE1, E2: caseE2, E3: caseE3, E4: caseE4, E5: caseE5 };

function hit(r) {
  return r.prompt > 0 ? r.cacheRead / r.prompt : 0;
}

function missLine(events) {
  const misses = events.filter((e) => e.type === "cache_miss");
  if (misses.length === 0) return "无";
  return misses
    .map((m) => `${m.reason}${m.detail ? `:${m.detail}` : ""} ${fmt.k(m.missedTokens)}`)
    .join("；");
}

export function renderCacheReport(data) {
  const out = [`# 缓存验收实验（${data.date ?? new Date().toISOString().slice(0, 10)}）`, ""];
  out.push(
    "> 由 `scripts/cache-experiment.mjs` 生成（第三波 §1.13）。「读 / 输入」= cacheRead /（input + cacheRead + cacheWrite），逐请求列出。",
    `> 合计请求 ${data.runs.reduce((s, r) => s + r.requests.length, 0)} 次。`,
    "",
  );
  const by = (c) => data.runs.filter((r) => r.case === c);
  const reqs = (r) =>
    r.requests
      .map(
        (q) =>
          `${q.purpose === "turn" ? "" : `${q.purpose}:`}${fmt.k(q.cacheRead)}/${fmt.k(q.prompt)}`,
      )
      .join(" · ");
  if (by("E1").length) {
    out.push("## E1 基线命中率", "");
    out.push(
      table(
        ["模型", "请求（读 / 输入）", "三态", "累计命中率", "未命中"],
        by("E1").map((r) => [
          r.model,
          reqs(r),
          r.stats?.reporting ?? "—",
          fmt.pct(r.stats?.hitRate),
          missLine(r.events),
        ]),
      ),
      "",
    );
  }
  if (by("E2").length) {
    out.push("## E2 长工具运行期间保温", "");
    out.push(
      table(
        [
          "模型",
          "保温",
          "TTL（用户自填）",
          "保温发送",
          "sleep 之后首个请求 读 / 输入",
          "请求（读 / 输入）",
        ],
        by("E2").map((r) => {
          const after = r.requests.filter((q) => q.purpose === "turn")[2];
          const sent = r.events.filter((e) => e.type === "cache_warm" && e.phase === "sent").length;
          return [
            r.model,
            r.warming,
            `${r.ttl}s`,
            String(sent),
            after
              ? `${fmt.k(after.cacheRead)}/${fmt.k(after.prompt)}（${fmt.pct(hit(after))}）`
              : "—",
            reqs(r),
          ];
        }),
      ),
      "",
    );
  }
  if (by("E3").length) {
    out.push("## E3 摘要请求", "");
    out.push(
      table(
        [
          "构建",
          "模型",
          "压缩前 token",
          "摘要请求 读 / 输入",
          "摘要请求数",
          "压缩后首个请求",
          "未命中",
        ],
        by("E3").map((r) => {
          const summary = r.requests.slice(r.compactAt, r.compactAt + r.summaryRequests);
          const next = r.requests[r.compactAt + r.summaryRequests];
          return [
            r.label ?? "",
            r.model,
            fmt.k(r.compaction?.tokensBefore ?? 0),
            summary
              .map((q) => `${fmt.k(q.cacheRead)}/${fmt.k(q.prompt)}（${fmt.pct(hit(q))}）`)
              .join(" + ") ||
              (r.compaction?.error ?? "—"),
            String(r.summaryRequests),
            next ? `${fmt.k(next.cacheRead)}/${fmt.k(next.prompt)}` : "—",
            missLine(r.events),
          ];
        }),
      ),
      "",
    );
  }
  if (by("E4").length) {
    out.push("## E4 未命中归因", "");
    for (const r of by("E4")) {
      out.push(
        `### ${r.model}，AGENTS.md ${r.pad ? `垫 ${fmt.k(r.pad)} 字符` : "不垫"}（首个请求输入 ${fmt.k(r.requests[0]?.prompt ?? 0)}）`,
        "",
      );
      out.push(
        table(
          ["步骤", "cache_miss"],
          r.steps.map((s) => [s.step, missLine(s.misses)]),
        ),
        "",
        `请求（读 / 输入）：${reqs(r)}`,
        "",
      );
    }
  }
  if (by("E5").length) {
    out.push("## E5 不报缓存的端点", "");
    out.push(
      table(
        ["模型", "每轮后三态", "probe 判定", "probe 两次 读 / 输入", "未命中"],
        by("E5").map((r) => [
          r.model,
          r.states.join(" → "),
          r.probe?.verdict ?? "—",
          (r.probe?.shots ?? [])
            .map((s) => `${fmt.k(s.cacheRead)}/${fmt.k(s.input + s.cacheRead + s.cacheWrite)}`)
            .join(" · "),
          missLine(r.events),
        ]),
      ),
      "",
    );
  }
  return out.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      case: { type: "string", default: "E1" },
      model: { type: "string" },
      models: { type: "string" },
      "max-requests": { type: "string" },
      "budget-usd": { type: "string" },
      "per-run": { type: "string", default: "15" },
      warming: { type: "string", default: "streaming" },
      ttl: { type: "string", default: "300" },
      "switch-to": { type: "string", default: "packy/MiniMax-M2.7" },
      "e4-pad": { type: "string", default: "24000" },
      seed: { type: "string" },
      dist: { type: "string" },
      label: { type: "string", default: "改进后" },
      json: { type: "string" },
      render: { type: "string" },
      // 单个用例换模型列表（同一进程里跑，三态跟踪器进程内共享）。
      e1: { type: "string" },
      e2: { type: "string" },
      e3: { type: "string" },
      e4: { type: "string" },
      e5: { type: "string" },
      out: { type: "string" },
    },
  });
  if (values.render) {
    const report = renderCacheReport(JSON.parse(readFileSync(values.render, "utf8")));
    if (values.out) writeFileSync(values.out, `${report}\n`);
    else process.stdout.write(`${report}\n`);
    return;
  }
  const settings = realSettings({ ...values, models: values.models ?? values.model });
  if (settings.models.length === 0) throw new Error("--model / --models / AMA_REAL_MODELS 为空");
  const dist = await loadDist(values.dist);
  const budget = new RealBudget({
    maxRequests: settings.maxRequests,
    budgetUsd: settings.budgetUsd,
    perRunMax: Number(values["per-run"]),
  });
  const ctx = { dist, budget, settings, values };
  const data =
    values.json && existsSync(values.json)
      ? JSON.parse(readFileSync(values.json, "utf8"))
      : { date: new Date().toISOString().slice(0, 10), runs: [] };
  const save = () => values.json && writeFileSync(values.json, JSON.stringify(data, null, 2));
  // 预热三态：在本进程里先对这些模型各发两句短问答，让端点进入 reported（三态进程内共享；
  // 切模型时新端点处于 unknown 不判未命中，E4 要看到 model_changed 需要先预热切换目标）。
  for (const model of values.seed?.split(",").filter(Boolean) ?? []) {
    const s = await Session.open({ ...ctx, model, label: `seed ${model}` });
    await s.prompt("Reply with just: ok");
    await s.prompt("Reply with just: ok");
    const stats = await s.close();
    process.stderr.write(`cache-experiment: seed ${model} → ${stats.cache?.reporting}\n`);
  }
  outer: for (const name of values.case.split(",")) {
    const run = CASES[name];
    if (!run) throw new Error(`未知用例 ${name}`);
    const models = values[name.toLowerCase()]?.split(",").filter(Boolean) ?? settings.models;
    for (const model of models) {
      if (budget.blocker() && !budget.blocker().startsWith("单次")) {
        budget.stopped ??= budget.blocker();
        break outer;
      }
      const started = Date.now();
      const result = await run(ctx, model);
      result.wallMs = Date.now() - started;
      data.runs.push(result);
      save();
      process.stderr.write(
        `cache-experiment: ${name} ${model} · ${result.requests.length} 请求 · ${fmt.s(result.wallMs)}（累计 ${budget.requests} 请求 $${budget.usd.toFixed(3)}）\n`,
      );
      if (budget.stopped) break outer;
    }
  }
  if (budget.stopped) process.stderr.write(`cache-experiment: 提前停止：${budget.stopped}\n`);
  if (!values.json) process.stdout.write(`${renderCacheReport(data)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`cache-experiment: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
