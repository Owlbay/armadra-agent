/**
 * 消息目录：subcommands（键名规范见 docs/i18n.md）。[W6-C0 建空壳，W6-I1 迁入 `src/cli/subcommands/**`]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * 用法文本（`usage`）整段一个键：列对齐是手工排的。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";
import * as configShow from "./subcommands-config.js";
import * as modelsEnabled from "./subcommands-models.js";

export const en = {
  ...configShow.en,
  ...modelsEnabled.en,
  /** 多个子命令共用。 */
  common: {
    warning: (text: string) => `ama: warning: ${text}\n`,
    cancelled: "ama: cancelled\n",
    extraArgs: (text: string) => `Unexpected arguments: ${text}`,
    needsArg: (command: string, arg: string) => `${command} needs ${arg}`,
    unknownSubcommand: (group: string, name: string) => `Unknown ${group} subcommand: ${name}`,
    unknownOption: (option: string) => `Unknown option: --${option}`,
    invalidChoice: (flag: string, choices: readonly string[], got: string) =>
      `${flag} must be one of ${choices.join(" | ")} (got ${got})`,
    notAssembled: (name: string) =>
      `ama: ${name} is not assembled yet (the integration batch injects the provider registry)\n`,
    providerNotFound: (id: string) => `ama: provider not found: ${id}\n`,
    modelNotFound: (ref: string, candidates: readonly string[] = []) =>
      `ama: model not found: ${ref}` +
      (candidates.length > 0 ? `; candidates: ${candidates.join(", ")}` : "") +
      "\n",
    noApiKey: (id: string) => `ama: ${id} has no API key (ama auth set ${id})\n`,
    apiNotImplemented: (api: string) => `ama: protocol ${api} is not implemented yet\n`,
  },
  providers: {
    usage: `Usage: ama providers add <id> --base-url <url> [--channel <name>=<api>@<url> …]
                          [--api openai-completions|openai-responses|anthropic-messages|auto]
                          [--key-env <VAR>] [--probe] [--limit N] [--probe-models a,b,…]
                          [--max-requests N] [--concurrency N] [--probe-timeout ms]
                          [--prefer chat,responses,messages] [--include-no-tools] [--yes]
       ama providers list
       ama providers channels <id>
       ama providers remove <id>
       ama providers refresh <id> [--probe] [--limit N] [--probe-models a,b,…] [--max-requests N]
                              [--concurrency N] [--probe-timeout ms] [--yes]
`,
    positiveInt: (name: string, raw: string) => `--${name} needs a positive integer: ${raw}`,
    needsYes: (what: string) => `ama: ${what}; add --yes in non-interactive environments\n`,
    probePlan: (models: number, requests: number, max: number, dropped: number) =>
      `\nProbe: ${plural(models, "model")}, ${plural(requests, "minimal request")} (1 per model per channel, limit ${max})` +
      (dropped > 0 ? `; ${dropped} more over the limit are not probed` : "") +
      "\n",
    confirmProbe: (requests: number, path: string) =>
      `Will send ${plural(requests, "billed request")} and write ${path}`,
    invalidKeyEnv: (name: string) => `--key-env is not a valid variable name: ${name}`,
    keyEnvUnset: (name: string) =>
      `ama: warning: environment variable ${name} is not set; listing and probing will go without a key\n`,
    keyPrompt: (id: string) => `Enter the API key for ${id} (not echoed), then press Enter: `,
    noKeyOnStdin: "No key read from stdin (or use --key-env <VAR>)",
    invalidId: (id: string) => `Invalid provider id: ${id}`,
    missingInConfig: (path: string, id: string) =>
      `ama: ${path} has no provider ${id} (run ama providers add first)\n`,
    needsBaseUrl: "ama providers add needs --base-url <url> or --channel",
    baseUrlNotHttp: (url: string) => `--base-url must be an http(s) URL: ${url}`,
    noChannel: (id: string) => `${id} has no usable channel`,
    listFailed: (id: string, message: string) =>
      `ama: failed to list models of ${id}: ${message}\n`,
    discovered: (id: string, n: number, url: string) =>
      `${id}: found ${plural(n, "model")} (${url})\n`,
    candidates: (list: readonly { name: string; api: string; baseUrl: string }[]) =>
      `Candidate channels: ${list.map((c) => `${c.name} (${c.api} ${c.baseUrl})`).join(" · ")}\n`,
    goneUpstream: (ids: readonly string[]) =>
      `No longer listed upstream (not removed): ${ids.join(", ")}\n`,
    writeSummary: (s: {
      path: string;
      id: string;
      channels: readonly string[];
      models: number;
      authFile?: string | undefined;
      defaultModel?: string | undefined;
    }) =>
      `\nWill write ${s.path}: ${s.id} new channels ${s.channels.join(", ") || "none"}, ` +
      `${plural(s.models, "new model")}` +
      (s.authFile !== undefined ? `; key → ${s.authFile} (0600)` : "") +
      (s.defaultModel !== undefined ? `; defaultModel → ${s.defaultModel}` : "") +
      "\n",
    defaultPick: (id: string, reason: string) => `  picked ${id}: ${reason}\n`,
    noDefaultPick:
      "  defaultModel not set: no model has tool calling, context ≥ 64k and known prices at once; set it with ama config edit\n",
    nothingToWrite: "Nothing to write\n",
    confirmWrite: "Confirm write",
    written: (path: string, backup: boolean) =>
      `Wrote ${path}${backup ? " (previous file backed up as config.json.bak)" : ""}\n`,
    tryIt: (ref: string) => `Try: ama -p "hi" --model ${ref}\n`,
    probeStopped: (reason: string) => `ama: probing stopped early (${reason})\n`,
    channelNeedsValue: "--channel needs a value",
  },
  providersList: {
    keyCommand: "!command (config.json)",
    keyLiteral: "literal (config.json)",
    keySameProvider: "same as provider",
    keyNone: "none",
    keyEnv: (name: string) => `env ${name}`,
    providerLine: (s: {
      id: string;
      builtin: boolean;
      channels: number;
      endpoint: string;
      models: number;
      key: string;
    }) =>
      `${s.id}  ${s.builtin ? "built-in" : "custom"} · ${s.channels > 0 ? plural(s.channels, "channel") : s.endpoint} · ` +
      `${plural(s.models, "model")} · key ${s.key}\n`,
    channelLine: (name: string, api: string, url: string, models: number, key: string) =>
      `  @${name}  ${api}  ${url}  ${plural(models, "model")} · key ${key}\n`,
    noProviders: "No providers configured (ama providers add <id> --base-url <url>)\n",
    singleChannel: (id: string, api: string, url: string, models: number) =>
      `${id}: single channel (${api} ${url}), ${plural(models, "model")}\n`,
    channelDetail: (s: {
      name: string;
      isDefault: boolean;
      short: string;
      api: string;
      url: string;
      key: string;
      models: readonly string[];
    }) =>
      `@${s.name}${s.isDefault ? " (default)" : ""}  ${s.short}  ${s.api}  ${s.url}  key ${s.key}\n` +
      `  ${plural(s.models.length, "model")}${s.models.length > 0 ? `: ${s.models.join(", ")}` : ""}\n`,
    removed: (path: string, id: string) =>
      `Removed ${id} from ${path} (previous file backed up as config.json.bak)\n`,
    keysRemoved: (path: string, id: string, n: number) =>
      `Deleted ${plural(n, "key")} of ${id} from ${path}\n`,
    noSuchProvider: (id: string) => `ama: no provider ${id}\n`,
  },
  providersPlan: {
    channelSpec: (spec: string) => `--channel must be <name>=<api>@<url>: ${spec}`,
    channelName: (name: string) => `Invalid channel name: ${name}`,
    channelApi: (choices: readonly string[], got: string) =>
      `--channel api must be one of ${choices.join(" | ")} (got ${got})`,
    channelUrl: (url: string) => `--channel url must be an http(s) URL: ${url}`,
    status: {
      ok: "probe passed",
      unprobed: "not probed",
      failed: "probe failed, not written",
      noTools: "no tool calling, not written",
      noChannel: "no candidate channel works, not written",
      existing: "already present, unchanged",
    },
    yes: "yes",
    no: "no",
    head: {
      model: "model",
      channel: "channel",
      context: "context",
      output: "output",
      image: "image",
      reasoning: "reasoning",
      tools: "tools",
      price: "price$/M",
      status: "status",
    },
  },
  probe: {
    throttled: (n: number) =>
      `  hit 429 rate limiting, concurrency down to ${n}, retrying once later\n`,
    recovered: (n: number) => `  no rate limiting for a while, concurrency back up to ${n}\n`,
    modelLine: (
      id: string,
      ok: readonly string[],
      failed: readonly { name: string; error: string }[],
      complete: boolean,
    ) =>
      `  ${id}  ${ok.length > 0 ? ok.join(", ") : "all failed"}` +
      (failed.length > 0
        ? ` (failed ${failed.map((f) => `${f.name}: ${f.error}`).join("; ")})`
        : "") +
      (complete ? "" : " (probing stopped early, some channels not probed)") +
      "\n",
    apiNotImplemented: (api: string) => `protocol ${api} is not implemented yet`,
    timeout: (seconds: number) => `timeout (no response within ${seconds} s)`,
    rateLimitedStop: (error: string) => `repeated 429 rate limiting: ${error}`,
    intRange: (name: string, min: number, max: number, raw: string) =>
      `--${name} needs an integer in ${min}–${max}: ${raw}`,
    plan: (concurrency: number, timeoutSeconds: number, worst: number) =>
      `concurrency ${concurrency}, at most ${timeoutSeconds} s per request, at most ${worst} s in total`,
    done: (done: number, total: number, seconds: string) =>
      `Probing done ${done}/${total} in ${seconds} s\n`,
    progress: (done: number, total: number) => `Probing ${done}/${total}`,
  },
  stats: {
    usage: `Usage: ama stats [--since 7d|30d|today|YYYY-MM-DD] [--until …]
                 [--by day|week|month|provider|channel|model|project]
                 [--project <dir> | --all] [--top N] [--json] [--no-cache] [--session-dir <dir>]
`,
    daysAtLeastOne: (option: string, raw: string) =>
      `--${option} needs at least 1 day (got ${raw})`,
    daySpec: (option: string, raw: string) =>
      `--${option} must be 7d, today or YYYY-MM-DD (got ${raw})`,
    allTime: "all time",
    range: (since: string | undefined, until: string | undefined) =>
      `${since ?? "earliest"} – ${until ?? "today"}`,
    header: (range: string, scope: string, sessions: number) =>
      `${range} · ${scope} · ${plural(sessions, "session")}`,
    noRequests: "No model requests",
    kindTurn: "chat",
    costUnpriced: "— (no request had a priced model; see tokens)",
    costPartial: (cost: string, unpriced: number) =>
      `${cost} (${plural(unpriced, "more request")} without prices, not included)`,
    rows: {
      requests: "Requests",
      turns: "Turns",
      tokens: "Tokens",
      hitRate: "Cache hit rate",
      cost: "Cost",
      subscription: "Subscription",
      errors: "Errors / retries",
    },
    subscriptionValue: (requests: number) =>
      `${plural(requests, "request")} on a ChatGPT plan (not billed in USD, not in the cost)`,
    requestsValue: (requests: number, kinds: string) => `${requests} (${kinds})`,
    turnsValue: (turns: number, avg: string) => `${turns} · avg ${avg}`,
    tokensValue: (input: string, output: string, read: string, write: string) =>
      `input ${input} · output ${output} · cache read ${read} · cache write ${write}`,
    hitRateValue: (rate: string, reported: number, total: number) =>
      `${rate} (endpoints reporting cache ${reported}/${total}; the rest are not in the denominator)`,
    groupHead: {
      sessions: "sessions",
      requests: "requests",
      turns: "turns",
      input: "input",
      output: "output",
      cacheRead: "cache rd",
      cacheWrite: "cache wr",
      hitRate: "hit rate",
      cost: "cost",
    },
    topTools: (n: number) => `Top ${n} tool calls`,
    noPositionals: (arg: string) => `ama stats takes no positional arguments: ${arg}`,
    topNonNegative: "--top must be a non-negative integer",
    allProjects: "all projects",
    project: (path: string) => `project ${path}`,
    skippedInvalid: (n: number) => `ama: skipped ${plural(n, "unreadable session file")}\n`,
  },
  models: {
    usage: (lines: readonly string[]) => `Usage: ${lines.join("\n       ")}\n`,
    refreshCatalogUsage: "ama models refresh-catalog (old name of refresh)",
    keyFrom: (source: string, origin?: string) =>
      `key: ${source}${origin !== undefined ? ` (${origin})` : ""}`,
    noKey: "no key",
    keyNotNeeded: "no key needed",
    checkFailed: (ref: string, ms: number, error: string) =>
      `ama: ${ref} failed (${ms} ms): ${error}\n`,
    checkOk: (ref: string, api: string, ms: number, stopReason: string) =>
      `${ref} available (${api}, ${ms} ms, stopReason ${stopReason})\n`,
    refreshing: (fetchedAt: string) => `Built-in snapshot: ${fetchedAt}; fetching models.dev…\n`,
    written: (path: string) => `Wrote ${path}\n`,
  },
  modelMeta: {
    reasoning: "thinking",
    image: "images",
    channels: (names: readonly string[]) => `channels ${names.join(",")}`,
    price: "price",
    sources: (
      parts: readonly string[],
      match: string | undefined,
      noTools: boolean,
      catalog?: string,
    ) =>
      `sources ${parts.join(" · ")}` +
      (catalog !== undefined ? `; catalog ${catalog}` : "") +
      (match !== undefined ? `; models.dev ${match}` : "") +
      (noTools ? "; no tool calling" : ""),
  },
  cacheProbe: {
    adviceSilent: (provider: string, cacheFieldPresent: boolean) =>
      `Set providers.${provider}.compat.cacheReporting: "silent" in config and the status bar will show not reported` +
      (cacheFieldPresent
        ? " (the response has cache fields but they stay 0; cache writes may also be delayed, try a larger --gap-ms)"
        : ""),
    adviceInconclusive:
      "The second request read only a little cache or only wrote: maybe cache granularity or TTL; retry with a larger --tokens or a shorter --gap-ms",
    advicePromptCache: (provider: string, id: string) =>
      `The catalog has no cache lifetime for this model, so ama neither warms it nor prunes early. Fill in promptCache only with a lifetime the upstream documents (providers.${provider}.modelOverrides: [{ "id": "${id}", "promptCache": { "short": <seconds> } }]); a guessed short value fires warming and early pruning while the cache is still valid`,
    intAtLeast: (name: string, min: number) => `--${name} must be an integer ≥ ${min}`,
    yes: "yes",
    no: "no",
    sample: (index: number, input: number, read: number, write: number, field: string) =>
      `#${index}  input ${input} · cacheRead ${read} · cacheWrite ${write} · cache fields ${field}`,
    head: (name: string, api: string, tokens: number, gapMs: number, estimate: string) =>
      `cache-probe ${name} (${api}) · prefix ≈ ${tokens} tokens · gap ${gapMs} ms\n` +
      `Estimated cost: ${estimate} (2 × ${tokens} tokens × catalog price)\n`,
    needsYes:
      "ama: cache-probe sends two billed requests; add --yes in non-interactive environments\n",
    requestFailed: (n: number, error: string) => `ama: request ${n} failed: ${error}\n`,
    share: (percent: number) => ` (the second request read ${percent}% of the prefix)`,
    usageFields: (api: string, fields: readonly string[]) =>
      `usage fields (read for ${api}): ${fields.join(" / ")}`,
    verdict: (verdict: string, share: string) => `Verdict: ${verdict}${share}`,
    advice: (advice: string) => `Advice: ${advice}`,
  },
  init: {
    usage: `Usage: ama init [--force]   Create the config directory (0700), config.json and config.schema.json
                           An existing config.json is kept (--force backs it up as .bak, then rewrites); auth.json is not created
`,
  },
  sessionsExport: {
    usage: `Usage: ama sessions export <id> [--format md|json|jsonl] [--output <file>] [--branch leaf|all]
                            [--session-dir <dir>]
`,
    exported: (path: string) => `Exported to ${path}\n`,
  },
  sessionsSearch: {
    usage: `Usage: ama sessions search <term|/regex/flags> [--all] [--role user|assistant|tool]
                            [--since 7d|today|YYYY-MM-DD] [--limit N] [--json] [--session-dir <dir>]
`,
    needsPattern: "ama sessions search needs a term or /regex/",
    invalidRegex: (message: string) => `Invalid regex: ${message}`,
    limitPositive: "--limit must be a positive integer",
    noHits: (all: boolean) =>
      all ? "No matches\n" : "No matches (only sessions of this directory; --all searches all)\n",
    truncated: (limit: number) => `(reached --limit ${limit}; there may be more)\n`,
  },
};

export const zh = {
  ...configShow.zh,
  ...modelsEnabled.zh,
  common: {
    warning: (text) => `ama: 警告：${text}\n`,
    cancelled: "ama: 已取消\n",
    extraArgs: (text) => `多余的参数：${text}`,
    needsArg: (command, arg) => `${command} 需要 ${arg}`,
    unknownSubcommand: (group, name) => `未知的 ${group} 子命令：${name}`,
    unknownOption: (option) => `未知选项：--${option}`,
    invalidChoice: (flag, choices, got) =>
      `${flag} 的取值应为 ${choices.join(" | ")}（收到 ${got}）`,
    notAssembled: (name) => `ama: ${name} 尚未装配（供应商注册表由集成批次注入）\n`,
    providerNotFound: (id) => `ama: 供应商不存在：${id}\n`,
    modelNotFound: (ref, candidates = []) =>
      `ama: 模型不存在：${ref}` +
      (candidates.length > 0 ? `；候选：${candidates.join(", ")}` : "") +
      "\n",
    noApiKey: (id) => `ama: ${id} 没有 API key（ama auth set ${id}）\n`,
    apiNotImplemented: (api) => `ama: 协议 ${api} 尚未实现\n`,
  },
  providers: {
    usage: `用法：ama providers add <id> --base-url <url> [--channel <名字>=<协议>@<地址> …]
                         [--api openai-completions|openai-responses|anthropic-messages|auto]
                         [--key-env <VAR>] [--probe] [--limit N] [--probe-models a,b,…]
                         [--max-requests N] [--concurrency N] [--probe-timeout ms]
                         [--prefer chat,responses,messages] [--include-no-tools] [--yes]
      ama providers list
      ama providers channels <id>
      ama providers remove <id>
      ama providers refresh <id> [--probe] [--limit N] [--probe-models a,b,…] [--max-requests N]
                             [--concurrency N] [--probe-timeout ms] [--yes]
`,
    positiveInt: (name, raw) => `--${name} 需要正整数：${raw}`,
    needsYes: (what) => `ama: ${what}，非交互环境需加 --yes\n`,
    probePlan: (models, requests, max, dropped) =>
      `\n探测：${models} 个模型、${requests} 次最小请求（每模型每渠道 1 次，上限 ${max}）` +
      (dropped > 0 ? `；另有 ${dropped} 个超出上限未探测` : "") +
      "\n",
    confirmProbe: (requests, path) => `将发 ${requests} 次计费请求并写入 ${path}`,
    invalidKeyEnv: (name) => `--key-env 不是合法的变量名：${name}`,
    keyEnvUnset: (name) => `ama: 警告：环境变量 ${name} 未设置，列模型与探测将不带 key\n`,
    keyPrompt: (id) => `输入 ${id} 的 API key（不回显），回车结束：`,
    noKeyOnStdin: "没有从 stdin 读到 key（或用 --key-env <VAR>）",
    invalidId: (id) => `供应商 id 不合法：${id}`,
    missingInConfig: (path, id) => `ama: ${path} 里没有供应商 ${id}（先 ama providers add）\n`,
    needsBaseUrl: "ama providers add 需要 --base-url <url> 或 --channel",
    baseUrlNotHttp: (url) => `--base-url 应为 http(s) URL：${url}`,
    noChannel: (id) => `${id} 没有可用的渠道`,
    listFailed: (id, message) => `ama: ${id} 模型列表获取失败：${message}\n`,
    discovered: (id, n, url) => `${id}：发现 ${n} 个模型（${url}）\n`,
    candidates: (list) =>
      `候选渠道：${list.map((c) => `${c.name}（${c.api} ${c.baseUrl}）`).join(" · ")}\n`,
    goneUpstream: (ids) => `上游已不再列出（未删除）：${ids.join(", ")}\n`,
    writeSummary: (s) =>
      `\n将写入 ${s.path}：${s.id} 新增渠道 ${s.channels.join(", ") || "无"}，` +
      `新增模型 ${s.models} 个` +
      (s.authFile !== undefined ? `；key → ${s.authFile}（0600）` : "") +
      (s.defaultModel !== undefined ? `；defaultModel → ${s.defaultModel}` : "") +
      "\n",
    defaultPick: (id, reason) => `  选 ${id}：${reason}\n`,
    noDefaultPick:
      "  未设置 defaultModel：没有同时支持工具调用、上下文 ≥ 64k 且有价格的模型；用 ama config edit 设置\n",
    nothingToWrite: "没有要写入的内容\n",
    confirmWrite: "确认写入",
    written: (path, backup) =>
      `已写入 ${path}${backup ? "（原文件备份为 config.json.bak）" : ""}\n`,
    tryIt: (ref) => `试试：ama -p "hi" --model ${ref}\n`,
    probeStopped: (reason) => `ama: 探测提前停止（${reason}）\n`,
    channelNeedsValue: "--channel 需要一个值",
  },
  providersList: {
    keyCommand: "!命令（config.json）",
    keyLiteral: "字面量（config.json）",
    keySameProvider: "同供应商",
    keyNone: "无",
    keyEnv: (name) => `环境变量 ${name}`,
    providerLine: (s) =>
      `${s.id}  ${s.builtin ? "内置" : "自定义"} · ${s.channels > 0 ? `${s.channels} 渠道` : s.endpoint} · ` +
      `${s.models} 模型 · key ${s.key}\n`,
    channelLine: (name, api, url, models, key) =>
      `  @${name}  ${api}  ${url}  ${models} 模型 · key ${key}\n`,
    noProviders: "没有配置供应商（ama providers add <id> --base-url <url>）\n",
    singleChannel: (id, api, url, models) => `${id}：单渠道（${api} ${url}），${models} 模型\n`,
    channelDetail: (s) =>
      `@${s.name}${s.isDefault ? "（缺省）" : ""}  ${s.short}  ${s.api}  ${s.url}  key ${s.key}\n` +
      `  ${s.models.length} 模型${s.models.length > 0 ? `：${s.models.join(", ")}` : ""}\n`,
    removed: (path, id) => `已从 ${path} 删除 ${id}（原文件备份为 config.json.bak）\n`,
    keysRemoved: (path, id, n) => `已删除 ${path} 里 ${id} 的 ${n} 个 key\n`,
    noSuchProvider: (id) => `ama: 没有供应商 ${id}\n`,
  },
  providersPlan: {
    channelSpec: (spec) => `--channel 应为 <名字>=<协议>@<地址>：${spec}`,
    channelName: (name) => `渠道名不合法：${name}`,
    channelApi: (choices, got) => `--channel 的协议应为 ${choices.join(" | ")}（收到 ${got}）`,
    channelUrl: (url) => `--channel 的地址应为 http(s) URL：${url}`,
    status: {
      ok: "探测通过",
      unprobed: "未探测",
      failed: "探测失败，不写入",
      noTools: "不支持工具调用，不写入",
      noChannel: "候选渠道都不支持，不写入",
      existing: "已存在，未改动",
    },
    yes: "是",
    no: "否",
    head: {
      model: "模型",
      channel: "渠道",
      context: "上下文",
      output: "输出",
      image: "图像",
      reasoning: "推理",
      tools: "工具",
      price: "价格$/M",
      status: "状态",
    },
  },
  probe: {
    throttled: (n) => `  遇到 429 限流，并发降到 ${n}，稍后重试一次\n`,
    recovered: (n) => `  一段时间没再限流，并发回升到 ${n}\n`,
    modelLine: (id, ok, failed, complete) =>
      `  ${id}  ${ok.length > 0 ? ok.join(", ") : "全部失败"}` +
      (failed.length > 0
        ? `（失败 ${failed.map((f) => `${f.name}：${f.error}`).join("；")}）`
        : "") +
      (complete ? "" : "（探测提前停止，部分渠道未探）") +
      "\n",
    apiNotImplemented: (api) => `协议 ${api} 尚未实现`,
    timeout: (seconds) => `超时（${seconds} s 内没有响应）`,
    rateLimitedStop: (error) => `连续 429 限流：${error}`,
    intRange: (name, min, max, raw) => `--${name} 需要 ${min}–${max} 的整数：${raw}`,
    plan: (concurrency, timeoutSeconds, worst) =>
      `并发 ${concurrency}，单次最长 ${timeoutSeconds} s，预计不超过 ${worst} s`,
    done: (done, total, seconds) => `探测完成 ${done}/${total}，用时 ${seconds} s\n`,
    progress: (done, total) => `探测 ${done}/${total}`,
  },
  stats: {
    usage: `用法：ama stats [--since 7d|30d|today|YYYY-MM-DD] [--until …]
                 [--by day|week|month|provider|channel|model|project]
                 [--project <目录> | --all] [--top N] [--json] [--no-cache] [--session-dir <目录>]
`,
    daysAtLeastOne: (option, raw) => `--${option} 的天数至少为 1（收到 ${raw}）`,
    daySpec: (option, raw) => `--${option} 应为 7d、today 或 YYYY-MM-DD（收到 ${raw}）`,
    allTime: "全部时间",
    range: (since, until) => `${since ?? "最早"} – ${until ?? "今天"}`,
    header: (range, scope, sessions) => `${range} · ${scope} · ${sessions} 个会话`,
    noRequests: "没有模型请求",
    kindTurn: "对话",
    costUnpriced: "— （所有请求的模型都无价格，见 token）",
    costPartial: (cost, unpriced) => `${cost}（另有 ${unpriced} 次请求无价，未计入）`,
    rows: {
      requests: "请求",
      turns: "回合",
      tokens: "Token",
      hitRate: "缓存命中率",
      cost: "费用",
      subscription: "订阅",
      errors: "错误 / 重试",
    },
    subscriptionValue: (requests) => `${requests} 次请求走 ChatGPT 套餐（不折算美元、不计入费用）`,
    requestsValue: (requests, kinds) => `${requests}（${kinds}）`,
    turnsValue: (turns, avg) => `${turns} · 平均耗时 ${avg}`,
    tokensValue: (input, output, read, write) =>
      `输入 ${input} · 输出 ${output} · 缓存读 ${read} · 缓存写 ${write}`,
    hitRateValue: (rate, reported, total) =>
      `${rate}（报告缓存的端点 ${reported}/${total}，其余不进分母）`,
    groupHead: {
      sessions: "会话",
      requests: "请求",
      turns: "回合",
      input: "输入",
      output: "输出",
      cacheRead: "缓存读",
      cacheWrite: "缓存写",
      hitRate: "命中率",
      cost: "费用",
    },
    topTools: (n) => `工具调用 Top ${n}`,
    noPositionals: (arg) => `ama stats 不接受位置参数：${arg}`,
    topNonNegative: "--top 应为非负整数",
    allProjects: "全部项目",
    project: (path) => `项目 ${path}`,
    skippedInvalid: (n) => `ama: 跳过 ${n} 个无法读取的会话文件\n`,
  },
  models: {
    usage: (lines) => `用法：${lines.join("\n      ")}\n`,
    refreshCatalogUsage: "ama models refresh-catalog（refresh 的旧名）",
    keyFrom: (source, origin) => `key：${source}${origin !== undefined ? `（${origin}）` : ""}`,
    noKey: "无 key",
    keyNotNeeded: "无需 key",
    checkFailed: (ref, ms, error) => `ama: ${ref} 失败（${ms} ms）：${error}\n`,
    checkOk: (ref, api, ms, stopReason) =>
      `${ref} 可用（${api}，${ms} ms，stopReason ${stopReason}）\n`,
    refreshing: (fetchedAt) => `内置快照：${fetchedAt}；正在拉取 models.dev…\n`,
    written: (path) => `已写入 ${path}\n`,
  },
  modelMeta: {
    reasoning: "思考",
    image: "图片",
    channels: (names) => `渠道 ${names.join(",")}`,
    price: "价格",
    sources: (parts, match, noTools, catalog) =>
      `来源 ${parts.join(" · ")}` +
      (catalog !== undefined ? `；目录 ${catalog}` : "") +
      (match !== undefined ? `；models.dev ${match}` : "") +
      (noTools ? "；不支持工具调用" : ""),
  },
  cacheProbe: {
    adviceSilent: (provider, cacheFieldPresent) =>
      `可在 config 里设 providers.${provider}.compat.cacheReporting: "silent"，状态栏将显示未报告` +
      (cacheFieldPresent
        ? "（响应里有缓存字段但恒为 0；也可能是缓存写入有延迟，可加大 --gap-ms 再测一次）"
        : ""),
    adviceInconclusive:
      "第二次只读到少量缓存或只有写入：可能是缓存粒度或 TTL 问题，可加大 --tokens 或缩短 --gap-ms 重试",
    advicePromptCache: (provider, id) =>
      `目录里没有这个模型的缓存寿命，ama 不保温、也不提前裁剪。只有上游文档写明了寿命时才填 promptCache（providers.${provider}.modelOverrides: [{ "id": "${id}", "promptCache": { "short": <秒数> } }]）；猜一个偏短的值会在缓存仍有效时触发保温和提前裁剪`,
    intAtLeast: (name, min) => `--${name} 应为不小于 ${min} 的整数`,
    yes: "有",
    no: "无",
    sample: (index, input, read, write, field) =>
      `#${index}  input ${input} · cacheRead ${read} · cacheWrite ${write} · 缓存字段 ${field}`,
    head: (name, api, tokens, gapMs, estimate) =>
      `cache-probe ${name}（${api}）· 前缀约 ${tokens} token · 间隔 ${gapMs} ms\n` +
      `预估花费：${estimate}（两次 × ${tokens} token × 目录价）\n`,
    needsYes: "ama: cache-probe 会发两次计费请求，非交互环境需加 --yes\n",
    requestFailed: (n, error) => `ama: 第 ${n} 次请求失败：${error}\n`,
    share: (percent) => `（第二次读到前缀的 ${percent}%）`,
    usageFields: (api, fields) => `usage 字段（${api} 读取）：${fields.join(" / ")}`,
    verdict: (verdict, share) => `判定：${verdict}${share}`,
    advice: (advice) => `建议：${advice}`,
  },
  init: {
    usage: `用法：ama init [--force]   建配置目录（0700）与 config.json、config.schema.json
                          已有的 config.json 不覆盖（--force 先备份为 .bak 再重写）；不创建 auth.json
`,
  },
  sessionsExport: {
    usage: `用法：ama sessions export <id> [--format md|json|jsonl] [--output <文件>] [--branch leaf|all]
                            [--session-dir <目录>]
`,
    exported: (path) => `已导出到 ${path}\n`,
  },
  sessionsSearch: {
    usage: `用法：ama sessions search <关键词|/正则/标志> [--all] [--role user|assistant|tool]
                            [--since 7d|today|YYYY-MM-DD] [--limit N] [--json] [--session-dir <目录>]
`,
    needsPattern: "ama sessions search 需要关键词或 /正则/",
    invalidRegex: (message) => `正则无效：${message}`,
    limitPositive: "--limit 应为正整数",
    noHits: (all) => (all ? "没有命中\n" : "没有命中（只搜了当前目录的会话，--all 搜全部）\n"),
    truncated: (limit) => `（已到 --limit ${limit}，可能还有更多）\n`,
  },
} satisfies Messages<typeof en>;
