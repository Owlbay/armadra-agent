/**
 * 缓存实验 E6（第五波 §8.4）：自动压缩 C1–C3 的缓存与费用。由 `cache-experiment.mjs --case E6` 调用。
 *
 * 模型窗口改小到 `--e6-window`（缺省 40k），一条提示里逐个读 12 个约 12 KB 的文件（单提示长任务，
 * 第五波 G1 的形态），停 `--e6-pause` 秒（缺省 330，> 用户自填 TTL `--ttl`）后再读一个。
 * `--e6-variant`：`baseline`（配 `--dist` 指向改动前构建）、`c1c2`（关掉冷时提前裁）、`c1c2c3`。
 * `--e6-files` 改文件数，`--e6-keep` 设 `compaction.prune.keepResults`（例如 3 个文件 + keep 1：
 * 第一条提示停在档一阈值以下，专看停顿后冷时提前裁）。
 */

import { fmt, table } from "./real-budget.mjs";
import {
  Session,
  bigText,
  hit,
  missLine,
  patchModel,
  sleep,
  summarizeRequests,
} from "./cache-experiment.mjs";

/** 约 12 KB 的确定性文本（≈ 3k token）。 */
function mediumText(tag) {
  return bigText(tag).slice(0, 12_000);
}

export async function caseE6(ctx, model) {
  const variant = ctx.values["e6-variant"];
  const window = Number(ctx.values["e6-window"]);
  const fileCount = Number(ctx.values["e6-files"]);
  const keep = ctx.values["e6-keep"];
  const compaction =
    keep === undefined ? {} : { compaction: { prune: { keepResults: Number(keep) } } };
  const ttl = Number(ctx.values.ttl);
  const files = {};
  for (let n = 1; n <= fileCount + 1; n++) files[`part${n}.txt`] = mediumText(`part${n}`);
  const s = await Session.open({
    ...ctx,
    model,
    label: `E6 ${model} ${variant}`,
    files,
    // 窗口改小，让 12 个文件跨过档一 / 档二阈值；TTL 用户自填（中转目录没有）
    patch: (config) =>
      patchModel(config, model, { contextWindow: window, promptCache: { short: ttl } }),
    extra: { cache: { warming: "off" }, ...compaction },
  });
  // c1c2：关掉冷时提前裁（C3），其余同 c1c2c3
  if (variant === "c1c2") s.runtime.session.cache.isCold = () => false;
  const compactions = [];
  const prunes = [];
  s.runtime.session.subscribe((event) => {
    const at = s.requests().length;
    if (event.type === "compaction_end")
      compactions.push({
        at,
        trigger: event.trigger,
        ok: event.result !== undefined,
        error: event.error,
      });
    if (
      event.type === "entry_appended" &&
      event.entry.type === "context_edit" &&
      event.entry.reason === "prune"
    )
      prunes.push(at);
  });
  await s.prompt(
    `Read part1.txt through part${fileCount}.txt with the read tool in order, ONE file per reply ` +
      "(never several files at once, no other tools). After reading all of them, reply with only the last line of " +
      `part${fileCount}.txt.`,
  );
  const pauseAt = s.requests().length;
  const pause = Number(ctx.values["e6-pause"]);
  if (!ctx.budget.stopped && pause > 0) await sleep(pause * 1000);
  if (!ctx.budget.stopped)
    await s.prompt(
      `Read part${fileCount + 1}.txt with the read tool and reply with only its last line.`,
    );
  const batches = [];
  for (const at of prunes) {
    const last = batches.at(-1);
    if (last !== undefined && last.at === at) last.count++;
    else batches.push({ at, count: 1 });
  }
  return {
    case: "E6",
    model,
    variant,
    label: ctx.values.label,
    files: fileCount,
    keepResults: keep === undefined ? undefined : Number(keep),
    window,
    ttl,
    pause,
    pauseAt,
    compactions,
    pruneBatches: batches,
    requests: summarizeRequests(s.requests()),
    usd: s.requests().reduce((sum, e) => sum + e.usd, 0),
    events: s.events,
    stats: (await s.close()).cache,
  };
}

/** Kimi 名义价（美元 / 百万 token，第三波报告同一口径；不是中转真实账单）。 */
const KIMI_PRICE = { input: 0.6, cacheRead: 0.15, output: 2.5 };

export function renderE6(runs) {
  const out = ["## E6 自动压缩（第五波 C1–C3）", ""];
  const sum = (r, key, filter = () => true) =>
    r.requests.filter(filter).reduce((s, q) => s + q[key], 0);
  out.push(
    table(
      [
        "构建",
        "请求（回合 / 摘要）",
        "输入合计",
        "cacheRead 合计（占比）",
        "全价输入（输入 − 读）",
        "归因未命中",
        "费用（Kimi 名义价）",
        "预算口径",
        "摘要压缩",
        "档一裁剪批次",
        "停顿后首个请求 读 / 输入",
      ],
      runs.map((r) => {
        const turns = r.requests.filter((q) => q.purpose === "turn").length;
        const prompt = sum(r, "prompt");
        const read = sum(r, "cacheRead");
        const nominal =
          ((prompt - read) * KIMI_PRICE.input +
            read * KIMI_PRICE.cacheRead +
            sum(r, "output") * KIMI_PRICE.output) /
          1e6;
        const after = r.requests[r.pauseAt];
        return [
          r.label ?? r.variant,
          `${r.requests.length}（${turns} / ${r.requests.length - turns}）`,
          fmt.k(prompt),
          `${fmt.k(read)}（${fmt.pct(prompt > 0 ? read / prompt : 0)}）`,
          fmt.k(prompt - read),
          fmt.k(r.stats?.reBilledTokens ?? 0),
          `$${nominal.toFixed(4)}`,
          `$${(r.usd ?? 0).toFixed(4)}`,
          r.compactions.map((c) => `${c.trigger}${c.ok ? "" : "✗"}@${c.at}`).join(" ") || "无",
          r.pruneBatches.map((b) => `${b.count}@${b.at}`).join(" ") || "无",
          after
            ? `${fmt.k(after.cacheRead)}/${fmt.k(after.prompt)}（${fmt.pct(hit(after))}）`
            : "—",
        ];
      }),
    ),
    "",
  );
  for (const r of runs)
    out.push(
      `- ${r.label ?? r.variant}：窗口 ${fmt.k(r.window)}、${r.files ?? 12} 个文件${r.keepResults === undefined ? "" : `、keepResults ${r.keepResults}`}、TTL ${r.ttl}s、停顿 ${r.pause}s；请求（读 / 输入）${r.requests
        .map(
          (q) =>
            `${q.purpose === "turn" ? "" : `${q.purpose}:`}${fmt.k(q.cacheRead)}/${fmt.k(q.prompt)}`,
        )
        .join(" · ")}；未命中 ${missLine(r.events)}`,
    );
  out.push("");
  return out;
}
