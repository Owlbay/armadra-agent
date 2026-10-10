#!/usr/bin/env node
/**
 * 渠道实测门（docs/history/wave5-plan.md §3.2，[W5-M2]）：对 `<provider>/<model>@<channel>` 跑四项，每个模型
 * ≤ 8 个请求，输出结果表。本地跑真实 key（CI 不跑；先 `pnpm build:lib`）。
 *
 *   node scripts/channel-probe.mjs --model deepseek/deepseek-v4-pro@messages
 *   node scripts/channel-probe.mjs --model zhipu/glm-5.3@messages,zhipu/glm-5.3@chat --json /tmp/probe.json
 *   node scripts/channel-probe.mjs --config /tmp/relay.json --model packy/kimi-k2.5@messages --gap-ms 8000
 *   node scripts/channel-probe.mjs --render /tmp/probe.json      # 按当前判门重画已有结果，不发请求
 *
 * | 项 | 做法 | 请求 | 通过 |
 * | --- | --- | --- | --- |
 * | ① check | 一次最小调用 `Reply with: ok` | 1 | 无错误且有文本 |
 * | ② 工具往返 | 让模型一次并行 `read` 临时目录里的两个文件、回答其中的口令 | 2（串行读时 3） | 有工具调用且最后回答含口令 |
 * | ③ thinking 两回合 | 接着 ② 的对话，thinking=medium 下读一个文件再回答（思考块随历史回放） | 2 | 第二次无错误且含口令（Messages 上无签名的思考块另行注明）；非推理模型记 n/a |
 * | ④ 缓存 | 同一约 3k token 的固定前缀相隔 `--gap-ms` 发两次 | 2 | 第二次 cacheRead > 0 |
 * | tool_use.id | ②③ 同一段对话里的全部工具调用 id | — | 互不相同（跨回合复用即不过） |
 *
 * ③ 往返成功但没有思考块、或 Messages 上的思考块没有签名（中转把上游 Chat 转成 Messages 时常见）记 ⚠：
 * 签名回放没被验证，不算过门。
 *
 * 四项全过且 id 唯一 → 「过门」：该家缺省可切到这个渠道（builtin.ts 改一行 defaultChannel）。
 *
 * 配置：`--config <config.json>`（缺省 `$AMA_CONFIG_DIR/config.json` 或 `~/.config/ama/config.json`，
 * 不存在就只用内置供应商）；key 照常从环境变量 / config / auth.json 解析，脚本不打印 key。
 * 成本：`--max-requests`（缺省每模型 8）、`--budget-usd`（缺省 1，全部模型合计；无目录价按保守估价）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const MAX_REQUESTS_PER_MODEL = 8;

const READ_TOOL = {
  name: "read",
  description: "Read a UTF-8 text file and return its content.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute file path" } },
    required: ["path"],
  },
};

/** 无目录价时的保守估价（美元每 M token），与 real-budget.mjs 一致。 */
const FALLBACK_PRICE = { input: 1, cacheRead: 1, cacheWrite: 1, output: 4 };

export function usageUsd(usage) {
  const total = usage?.cost?.total;
  if (typeof total === "number" && total > 0) return total;
  const u = usage ?? {};
  return (
    ((u.input ?? 0) * FALLBACK_PRICE.input +
      (u.cacheRead ?? 0) * FALLBACK_PRICE.cacheRead +
      (u.cacheWrite ?? 0) * FALLBACK_PRICE.cacheWrite +
      (u.output ?? 0) * FALLBACK_PRICE.output) /
    1e6
  );
}

/** 确定性的长前缀（约 `tokens` token，按 4 字符 / token 估）。 */
export function fixedPrefix(tokens = 3000) {
  const line =
    "Reference line {n}: the quick brown fox jumps over the lazy dog near the river bank.";
  const out = [];
  for (let n = 0; out.join("\n").length < tokens * 4; n++) out.push(line.replace("{n}", String(n)));
  return out.join("\n");
}

const text = (message) =>
  message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
const toolCalls = (message) => message.content.filter((b) => b.type === "toolCall");

class Budget {
  constructor({ maxRequests, budgetUsd }) {
    this.maxRequests = maxRequests;
    this.budgetUsd = budgetUsd;
    this.usd = 0;
  }
}

/**
 * 跑一个模型的四项。`registry`：ProviderRegistry（或同形状：findModel / resolveApiKey / getApi）。
 * 返回结果对象（不含 key）。
 */
export async function probeModel({
  registry,
  ref,
  gapMs = 3000,
  maxRequests = MAX_REQUESTS_PER_MODEL,
  budget = new Budget({ maxRequests: Infinity, budgetUsd: Infinity }),
  timeoutMs = 120_000,
}) {
  const result = {
    ref,
    channel: undefined,
    api: undefined,
    host: undefined,
    check: { status: "skip" },
    tools: { status: "skip" },
    thinking: { status: "skip" },
    cache: { status: "skip" },
    toolIds: [],
    idsUnique: undefined,
    requests: 0,
    usd: 0,
    pass: false,
    error: undefined,
  };
  const found = registry.findModel(ref);
  if (!found.ok) {
    result.error = `${found.reason}${found.candidates?.length ? `（候选：${found.candidates.slice(0, 5).join(", ")}）` : ""}`;
    return result;
  }
  const model = found.model;
  result.channel = model.channel ?? "default";
  result.api = model.api;
  try {
    result.host = new URL(model.baseUrl ?? "").host;
  } catch {
    result.host = model.baseUrl;
  }
  const impl = registry.getApi(model.api);
  if (!impl) {
    result.error = `协议 ${model.api} 未注册`;
    return result;
  }
  const { apiKey } = await registry.resolveApiKey(model.provider, model.channel);
  if (apiKey === undefined && model.requiresApiKey !== false) {
    result.error = "没有 key";
    return result;
  }
  const sessionId = `probe-${Date.now().toString(36)}`;

  /** 发一次；超出上限抛错（调用方记为该项失败）。 */
  const call = async (messages, extra = {}) => {
    if (result.requests >= maxRequests) throw new Error(`单模型请求数达到上限 ${maxRequests}`);
    if (budget.usd >= budget.budgetUsd) throw new Error(`预算达到上限 $${budget.budgetUsd}`);
    result.requests++;
    const stream = impl.stream(
      model,
      { messages },
      {
        signal: AbortSignal.timeout(timeoutMs),
        apiKey,
        sessionId,
        maxTokens: 1024,
        thinkingLevel: "off",
        ...extra,
      },
    );
    const message = await stream.result();
    const usd = usageUsd(message.usage);
    result.usd += usd;
    budget.usd += usd;
    return message;
  };
  const failed = (message) =>
    message.stopReason === "error" || message.stopReason === "aborted"
      ? (message.errorMessage ?? message.stopReason).slice(0, 200)
      : undefined;
  const system = (sections, tools) => ({
    role: "system",
    sections,
    ...(tools ? { toolsAdded: tools } : {}),
    timestamp: 1,
  });
  const user = (content, t = 2) => ({ role: "user", content, timestamp: t });

  // ① check
  try {
    const reply = await call([
      system({ preamble: "You are a terse assistant." }),
      user("Reply with: ok"),
    ]);
    const error = failed(reply);
    result.check =
      error === undefined && text(reply).trim().length > 0
        ? { status: "pass" }
        : { status: "fail", note: error ?? "空回复" };
  } catch (error) {
    result.check = { status: "fail", note: String(error.message ?? error) };
  }

  // ② ③ 工具往返：同一段对话里先 ② 再 ③（③ 开 thinking），tool_use.id 在这段对话里必须互不相同
  const dir = mkdtempSync(join(tmpdir(), "ama-probe-"));
  const fresh = () => [
    system({ preamble: "You are a coding agent. Use the read tool to inspect files." }, [
      READ_TOOL,
    ]),
  ];
  try {
    /** 两个文件时要求一次并行读两个（测多个 id）；一个文件时一读一答。追加在 `history` 上。 */
    const roundTrip = async (history, word, thinkingLevel, files) => {
      const fileA = join(dir, `a-${word}.txt`);
      const fileB = join(dir, `b-${word}.txt`);
      let prompt;
      if (files === 2) {
        writeFileSync(fileA, `The first half of the pass phrase is: ${word.slice(0, 4)}\n`);
        writeFileSync(fileB, `The second half of the pass phrase is: ${word.slice(4)}\n`);
        prompt = `Call the read tool for both files ${fileA} and ${fileB} in one response (two parallel calls), then reply with the full pass phrase (both halves joined, no spaces) and nothing else.`;
      } else {
        writeFileSync(fileA, `The pass phrase is: ${word}\n`);
        prompt = `Read the file ${fileA} with the read tool, then reply with the pass phrase and nothing else.`;
      }
      history.push(user(prompt));
      const ids = [];
      let thinkingBlocks = 0;
      let signed = 0;
      for (let turn = 0; turn < 3; turn++) {
        const reply = await call(history, { thinkingLevel });
        const error = failed(reply);
        if (error !== undefined)
          return { status: "fail", note: `第 ${turn + 1} 次：${error}`, ids };
        for (const block of reply.content) {
          if (block.type !== "thinking") continue;
          thinkingBlocks++;
          if (block.thinkingSignature) signed++;
        }
        history.push(reply);
        const calls = toolCalls(reply);
        if (calls.length === 0) {
          const answer = text(reply).replace(/\s+/g, "");
          const ok = turn > 0 && answer.toLowerCase().includes(word.toLowerCase());
          return {
            status: ok ? "pass" : "fail",
            note: ok
              ? undefined
              : turn === 0
                ? "没有调用工具"
                : `回答不含口令：${answer.slice(0, 60)}`,
            ids,
            thinkingBlocks,
            signed,
          };
        }
        for (const c of calls) {
          ids.push(c.id);
          const path = resolve(String(c.arguments?.path ?? ""));
          const inside = path.startsWith(dir + sep);
          let content;
          try {
            content = inside ? readFileSync(path, "utf8") : "error: outside the probe directory";
          } catch (error) {
            content = `error: ${error.message}`;
          }
          history.push({
            role: "toolResult",
            toolCallId: c.id,
            toolName: c.name,
            content,
            isError: content.startsWith("error:"),
            timestamp: 3,
          });
        }
        if (result.requests >= maxRequests) break;
      }
      return { status: "fail", note: "回合用尽", ids, thinkingBlocks, signed };
    };

    let history = fresh();
    try {
      result.tools = await roundTrip(history, "kestrel42", "off", 2);
    } catch (error) {
      result.tools = { status: "fail", note: String(error.message ?? error), ids: [] };
    }
    if (!model.reasoning) result.thinking = { status: "n/a", note: "非推理模型", ids: [] };
    else {
      try {
        // ② 没走完（历史停在工具结果上）就另起一段
        if (result.tools.status !== "pass") history = fresh();
        result.thinking = await roundTrip(history, "osprey77", "medium", 1);
      } catch (error) {
        result.thinking = { status: "fail", note: String(error.message ?? error), ids: [] };
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  result.toolIds = [...(result.tools.ids ?? []), ...(result.thinking.ids ?? [])];
  result.idsUnique =
    result.toolIds.length === 0
      ? undefined
      : new Set(result.toolIds).size === result.toolIds.length;

  // ④ 缓存
  try {
    const prefix = fixedPrefix(3000);
    const messages = [
      system({ preamble: "You are a terse assistant.", reference: prefix }),
      user("Reply with: ok"),
    ];
    const first = await call(messages, { maxTokens: 16 });
    const firstError = failed(first);
    if (firstError !== undefined) throw new Error(firstError);
    await sleep(gapMs);
    const second = await call(messages, { maxTokens: 16 });
    const secondError = failed(second);
    if (secondError !== undefined) throw new Error(secondError);
    const read = second.usage.cacheRead ?? 0;
    const prefixTokens = read + (second.usage.input ?? 0) + (second.usage.cacheWrite ?? 0);
    result.cache = {
      status: read > 0 ? "pass" : "fail",
      cacheRead: read,
      prefixTokens,
      firstWrite: first.usage.cacheWrite ?? 0,
      reported: second.usage.cacheReported,
      note: read > 0 ? undefined : second.usage.cacheReported ? "字段为 0" : "响应不报缓存",
    };
  } catch (error) {
    result.cache = { status: "fail", note: String(error.message ?? error) };
  }

  return gate(result);
}

/**
 * 判门（也用于 `--render` 重算旧结果）：③ 往返通过但没出思考块、或 Messages 上思考块没有签名（回放降级为
 * 文本，签名回放没被验证）记 `warn`；四项都是 pass / n/a 且 id 不重复才过门。
 */
export function gate(result) {
  const t = result.thinking;
  if (t.status === "pass" || t.status === "warn") {
    const blocks = t.thinkingBlocks ?? 0;
    const unsigned = blocks - (t.signed ?? 0);
    if (blocks === 0) Object.assign(t, { status: "warn", note: "没有思考块" });
    else if (result.api === "anthropic-messages" && unsigned > 0)
      Object.assign(t, { status: "warn", note: `${unsigned}/${blocks} 个思考块无签名` });
    else Object.assign(t, { status: "pass", note: undefined });
  }
  const ok = (s) => s.status === "pass" || s.status === "n/a";
  result.pass =
    ok(result.check) && ok(result.tools) && ok(t) && ok(result.cache) && result.idsUnique !== false;
  return result;
}

const mark = (step) =>
  step.status === "pass"
    ? "✓"
    : step.status === "n/a"
      ? "n/a"
      : step.status === "skip"
        ? "—"
        : `${step.status === "warn" ? "⚠" : "✗"}${step.note ? ` ${step.note.replace(/\|/g, "/").slice(0, 60)}` : ""}`;

/** 结果表（Markdown）。 */
export function renderTable(results) {
  const rows = [
    "| 模型@渠道 | 协议 · 主机 | ① check | ② 工具往返 | ③ thinking 两回合 | ④ 缓存（读 / 前缀） | id 唯一 | 请求 | 结论 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of results) {
    const cache =
      r.cache.cacheRead !== undefined
        ? `${mark(r.cache)} ${r.cache.cacheRead} / ${r.cache.prefixTokens}`
        : mark(r.cache);
    const ids = r.idsUnique === undefined ? "—" : r.idsUnique ? "✓" : "✗ 重复";
    rows.push(
      `| \`${r.ref}\` | ${r.api ?? "—"} · ${r.host ?? "—"} | ${r.error ? `✗ ${r.error}` : mark(r.check)} | ${mark(r.tools)} | ${mark(r.thinking)} | ${cache} | ${ids} | ${r.requests} | ${r.pass ? "**过门**" : "未过"} |`,
    );
  }
  return rows.join("\n");
}

async function loadRegistry(configPath) {
  const dist = join(ROOT, "dist");
  let mod;
  try {
    mod = await import(pathToFileURL(join(dist, "ai", "providers", "registry.js")).href);
  } catch (error) {
    throw new Error(`dist/ 不可用，先 pnpm build:lib（${error.message}）`);
  }
  let config = { version: 1 };
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const authFile = join(dirname(configPath), "auth.json");
  return new mod.ProviderRegistry({
    config,
    includeFake: true,
    keys: { userAuthFile: authFile },
    onWarning: (message) => process.stderr.write(`[warn] ${message}\n`),
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string", multiple: true },
      config: { type: "string" },
      json: { type: "string" },
      "gap-ms": { type: "string" },
      "max-requests": { type: "string" },
      "budget-usd": { type: "string" },
      render: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.render) {
    const results = JSON.parse(readFileSync(values.render, "utf8")).map(gate);
    process.stdout.write(`${renderTable(results)}\n`);
    return;
  }
  const refs = (values.model ?? [])
    .flatMap((m) => m.split(","))
    .map((m) => m.trim())
    .filter(Boolean);
  if (values.help || refs.length === 0) {
    process.stdout.write(
      "用法：node scripts/channel-probe.mjs --model <provider/model@channel>[,...] [--config path] [--json out] [--gap-ms 3000] [--max-requests 8] [--budget-usd 1]\n",
    );
    process.exit(refs.length === 0 && !values.help ? 2 : 0);
  }
  const configPath =
    values.config ??
    join(process.env.AMA_CONFIG_DIR ?? join(homedir(), ".config", "ama"), "config.json");
  const registry = await loadRegistry(configPath);
  const maxRequests = Math.min(Number(values["max-requests"] ?? MAX_REQUESTS_PER_MODEL), 8);
  const budget = new Budget({ maxRequests, budgetUsd: Number(values["budget-usd"] ?? 1) });
  const gapMs = Number(values["gap-ms"] ?? 3000);
  const results = [];
  for (const ref of refs) {
    process.stderr.write(`probe ${ref} …\n`);
    results.push(await probeModel({ registry, ref, gapMs, maxRequests, budget }));
  }
  const table = renderTable(results);
  process.stdout.write(
    `${table}\n\n请求 ${results.reduce((n, r) => n + r.requests, 0)} 次，估计 $${budget.usd.toFixed(4)}\n`,
  );
  if (values.json) writeFileSync(values.json, `${JSON.stringify(results, null, 2)}\n`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  });
}
