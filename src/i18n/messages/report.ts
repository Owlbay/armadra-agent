/**
 * 消息目录：report（键名规范见 docs/i18n.md）。[W6-C0 建空壳，W6-I3 迁入]
 *
 * 范围：斜杠命令语义层（`modes/commands-core.ts` 的命令说明与回执）、`/session` `/cache` 报告与缓存提示
 * （`modes/session-report.ts`）、启动期文本问答（`modes/startup-ui-text.ts`）、`ama doctor`。
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * `formatTokens` / `formatUsd` / `formatPercent` 的结果、`streaming` / `idle` 之类的枚举值不译。
 */

import type { CacheMissReason } from "../../ai/cache/types.js";
import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  /** 内置斜杠命令：`args` 只写需要翻译的占位，说明整句。 */
  commands: {
    help: "List commands",
    new: "Start a new session",
    resume: "Resume a session (pick one when no id)",
    forkArgs: "[entry id]",
    fork: "Fork a new session from an entry",
    compactArgs: "[instructions]",
    compact: "Compact the context",
    rewind: "Rewind the conversation and code to before a message",
    model: "Switch model",
    thinkingArgs: "[level]",
    thinking: "Thinking level off | minimal | low | medium | high | xhigh",
    permissionArgs: "[mode]",
    permission: "Permission mode plan | default | auto-edit | full-auto",
    toolsArgs: "[names…]",
    tools: "List / set active tools",
    hooks: "List loaded hooks",
    session: "Session info, usage and cache",
    cache: "Cache stats; switch warming for this session; print the prefix fingerprint",
    statusline: "Footer info two lines / one line (Ctrl+G)",
    planArgs: "[goal] | approve [mode|fresh] | reject",
    plan: "Show the plan and status; with a goal, enter Plan mode; approve / discard a pending plan",
    tasks: "Sub-agent tasks: status, output, stop, background",
    agents: "Sub-agent types and external agents (installed, version)",
    paste: "Paste an image from the clipboard (Ctrl+V)",
    exit: "Exit",
    config: "Settings panel; key=value sets one item directly (user level)",
    traceArgs: "[task id]",
    trace: "Trace: timing and usage of turns, requests and tools",
    memoryArgs: "[show|edit|rm <name> | on|off | reload]",
    memory: "Cross-session memory (needs memory.enabled)",
    skillLine: "/skill:<name> [args]  Use a skill",
    templateLine: "/<template> [args]  Expand a prompt template",
  },
  /** 斜杠命令的回执与用法错误。 */
  command: {
    warmingUnsupported: "this session cannot switch cache warming",
    warming: (mode: string) => `Warming: ${mode}`,
    warmingInvalid: (modes: readonly string[]) => `warming mode must be ${modes.join(" | ")}`,
    warmingSet: (mode: string) => `Warming: ${mode} (this session)`,
    cacheUsage: "usage: /cache [warm off|streaming|idle | fingerprint]",
    taskStopped: (id: string) => `Stopped ${id}`,
    tasksUsage: "usage: /tasks [id] | /tasks stop <id> | /tasks bg [id]",
    newSession: (id: string) => `New session ${id}`,
    resumed: (id: string, messages: number) =>
      `Resumed session ${id} (${plural(messages, "message")})`,
    forked: (id: string) => `Forked to new session ${id}`,
    compacted: (before: number, after: number | undefined) =>
      `Compacted: ${before}${after !== undefined ? ` → ${after}` : ""} tokens`,
    model: (ref: string) => `Model: ${ref}`,
    thinkingInvalid: (levels: readonly string[]) => `thinking level must be ${levels.join(" | ")}`,
    thinking: (level: string) => `Thinking level: ${level}`,
    permissionInvalid: (modes: readonly string[]) =>
      `permission mode must be ${modes.join(" | ")} (display names work too, e.g. "Accept edits")`,
    permissionCancelled: (mode: string) => `Cancelled; permission mode is still ${mode}`,
    permission: (mode: string) => `Permission mode: ${mode}`,
    tools: (active: readonly string[], inactive: readonly string[]) =>
      `Active: ${active.join(", ") || "(none)"}${inactive.length > 0 ? `\nAvailable: ${inactive.join(", ")}` : ""}`,
    noHooks: "No hooks loaded",
    pasted: (path: string) => `Pasted image: ${path}`,
    statuslineOnly: "/statusline is only available in the interactive UI",
  },
  /** 启动期文本问答（`--no-tui`、非 TTY）。 */
  startup: {
    more: (count: number) => `  …${count} more`,
    trustQuestion: (cwd: string) => `Trust this directory's project resources? ${cwd}`,
    trustChoices: "[y this time / a trust and remember / N don't trust] ",
    resumeQuestion: "Resume which session?",
    resumeAnswer: "Number or id: ",
    pickModel: "Choose a model:",
    pickModelAnswer: "Number or provider/id: ",
    cwdMissing: (path: string) => `The session's working directory does not exist: ${path}`,
    cwdAnswer: "Replacement directory (empty line cancels): ",
    notDirectory: (path: string) => `Not a directory: ${path}\n`,
  },
  /** `/session`、`/cache` 报告与缓存提示行。 */
  cache: {
    unreported: "not reported",
    unknown: "unknown",
    reason: (reason: CacheMissReason): string => {
      switch (reason) {
        case "prefix_changed":
          return "prefix changed";
        case "model_changed":
          return "model switched";
        case "idle":
          return "idle timeout";
        case "subtask":
          return "subtask";
        case "evicted":
          return "evicted by server";
      }
    },
    missIdle: (minutes: number) => `after ${plural(minutes, "minute")} idle`,
    missSubtask: (minutes: number) => `after a ${plural(minutes, "minute")} subtask`,
    missModel: "after switching model",
    missTools: "tool list changed",
    missSystem: "system prompt changed",
    missPrefix: "prefix changed",
    missEvicted: "evicted by the server",
    missNotice: (reason: string, tokens: string, cost: string | undefined) =>
      `Cache miss (${reason}): re-billed ${tokens} tokens${cost === undefined ? "" : ` (about ${cost})`}`,
    pressure: (percent: number) => `Context ${percent}% used`,
    pressureTurns: (percent: number, turns: number) =>
      `Context ${percent}% used, about ${plural(turns, "turn")} left (average of the last 5 turns)`,
    pressureTokens: (percent: number, tokens: string) =>
      `Context ${percent}% used, ${tokens} tokens left`,
    warmSent: (read: string | undefined, cost: string | undefined) => {
      const parts = [
        ...(read !== undefined ? [`read ${read} tokens`] : []),
        ...(cost !== undefined ? [cost] : []),
      ];
      return `Cache warming refreshed${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
    },
    stopReason: (reason: string): string =>
      ({
        retention_none: "cache retention is none",
        payload_replaced: "request body replaced by onPayload",
        thinking_budget: "thinking budget follows max_tokens, cannot replay",
        reporting_unknown: "endpoint has not reported cache yet",
        reporting_silent: "endpoint does not report cache",
        no_ttl: "model catalog has no cache TTL",
        ttl_too_short: "cache TTL too short",
        max_duration: "warming duration limit reached",
        late: "timer fired late",
        off: "off",
        stale: "context changed",
        declined: "declined by host",
        error: "warming request failed",
        no_cache_hits: "consecutive warmings with zero hits",
        no_price: "no price, cannot compute economics",
        below_min_savings: "expected savings below threshold",
      })[reason] ?? reason,
    stopped: "stopped",
    stoppedWith: (reason: string) => `stopped: ${reason}`,
    next: (duration: string) => `next in ${duration}`,
    savings: (amount: string, floor: string | undefined) =>
      `expected savings ${amount}${floor === undefined ? "" : ` ≥ ${floor}`}`,
    pending: "waiting for the next request",
    sent: (count: number, cost: string) => `sent ${count}× ${cost}`,
    missesNone: "0",
    misses: (count: number, tokens: string, cost: string, by: string) =>
      `${count}, re-billed ${tokens} tokens ≈ ${cost}${by !== "" ? ` (${by})` : ""}`,
    keyInput: "Input",
    input: (
      prompt: string,
      read: string,
      share: string | undefined,
      uncached: string,
      write: string | undefined,
    ) =>
      `${prompt} = cache read ${read}${share !== undefined ? ` (${share})` : ""} + uncached ${uncached}${write !== undefined ? ` (of which written ${write})` : ""}`,
    keyHitRate: "Hit rate",
    sessionRate: (rate: string) => `session ${rate}`,
    rates: (last: string, session: string) => `last ${last} · session ${session}`,
    keyReporting: "Reporting",
    keyMisses: "Misses",
    keyWarming: "Warming",
    keyContext: "Context",
    context: (percent: number, remaining: string | undefined, turns: number | undefined) =>
      `${percent}%${remaining !== undefined ? `, ≈ ${remaining} tokens left` : ""}${turns !== undefined ? ` ≈ ${plural(turns, "turn")}` : ""}`,
    keySubtasks: "Subtasks",
    subtasks: (count: number, rate: string, rebilled: string | undefined) =>
      `${plural(count, "session")}, hit rate ${rate}${rebilled !== undefined ? `, re-billed ${rebilled} tokens` : ""}`,
    title: "Cache",
  },
  /** `/session` 的其余段。 */
  session: {
    externalTokens: (tokens: string) => `${tokens} tokens`,
    externalRequests: (count: number) => plural(count, "request"),
    external: (runs: number, amount: string, tokens: string | undefined) =>
      `${plural(runs, "run")} · ${amount}${tokens !== undefined ? ` · ${tokens} tokens` : ""}`,
    tasks: (total: number) => plural(total, "task"),
    running: (count: number) => `running ${count}`,
    status: (status: string, count: number): string => {
      const labels: Record<string, string> = {
        completed: "completed",
        failed: "failed",
        aborted: "stopped",
        max_turns: "out of turns",
        interrupted: "interrupted",
      };
      return `${labels[status] ?? status} ${count}`;
    },
    tasksLine: (parts: readonly string[]) => `${parts.join(" · ")} (/tasks)`,
    keySession: "Session",
    session: (id: string, file: string | undefined) =>
      `${id}${file !== undefined ? ` (${file})` : " (not saved)"}`,
    keyModel: "Model",
    model: (model: string, thinking: string, permission: string) =>
      `${model} · thinking ${thinking} · permission ${permission}`,
    keyMessages: "Messages",
    messages: (user: number, assistant: number, tools: number) =>
      `user ${user} · assistant ${assistant} · tool calls ${tools}`,
    keyUsage: "Usage",
    usage: (input: number, output: number, cacheRead: number, cacheWrite: number, cost: string) =>
      `input ${input} · output ${output} · cache read ${cacheRead} · cache write ${cacheWrite} · ${cost}`,
    keyContext: "Context",
    context: (tokens: string, window: string, percent: string) =>
      `${tokens} / ${window} (${percent}%)`,
    keyAgents: "Sub-agents",
    externalTitle: "External agents",
    noFingerprint: "This session does not provide a prefix fingerprint",
    noRequestYet: "No real request yet (the fingerprint is recorded after the first request)",
    fingerprintTitle: "Prefix fingerprint (last request)",
  },
  /** `ama doctor`。 */
  doctor: {
    usage: "Usage: ama doctor [--profile <file>] [--auth-file <file>] [--trust | --no-trust]\n",
    missing: (label: string, path: string) => `${label}: ${path} (does not exist)`,
    labeled: (label: string, text: string) => `${label}: ${text}`,
    keySource: (source: string, origin: string | undefined) =>
      `${source}${origin !== undefined ? ` (${origin})` : ""}`,
    hookCommand: (command: string, ms: number) => `${command} (${ms} ms)`,
    codemode: (mode: string, reason: string) => `codemode: ${mode} (${reason})`,
    warning: (text: string) => `warning: ${text}`,
    trustTitle: "Trust",
    fromCli: "command line",
    noRecord: "default: no record, interactive mode will ask",
    trustInvalid: "trust.json is invalid",
    trust: (cwd: string, trusted: boolean, from: string) =>
      `${cwd}: ${trusted ? "trusted" : "not trusted"} (${from})`,
    gated: (trusted: boolean) => `Resources that need trust${trusted ? "" : " (not loaded now)"}:`,
    keysTitle: "Key sources (sources only, never values)",
    authMode: (mode: string, path: string) => `auth.json mode ${mode}, should be 600: ${path}`,
    none: "none",
    notNeeded: "not needed",
    baseUrlEnv: (env: string, url: string) =>
      `baseUrl from environment variable ${env}: ${url} (compat uses conservative defaults)`,
    model: (ref: string | undefined, reason: string) =>
      `Model to use: ${ref ?? "(none)"} (${reason})`,
    registry: (error: string) => `provider registry: ${error}`,
    envVars: (names: readonly string[]) =>
      `Environment variables: ${names.length > 0 ? names.join(", ") : "(none)"}`,
    empty: "(none)",
    hookSkipped: (path: string) => `not trusted, skipped: ${path}`,
    terminalTitle: "Terminal",
    tty: (stdin: boolean, stdout: boolean) =>
      `stdin TTY: ${stdin ? "yes" : "no"} · stdout TTY: ${stdout ? "yes" : "no"}`,
    term: (term: string | undefined, colorterm: string | undefined) =>
      `TERM=${term ?? "(unset)"} · COLORTERM=${colorterm ?? "(unset)"}`,
    noColor: "NO_COLOR is set: no colors",
    tmux: "running inside tmux",
    size: (columns: number, rows: number | undefined) => `Size: ${columns}×${rows}`,
    defaultUi: (tui: boolean) =>
      `Default UI: ${tui ? "terminal UI" : "line mode (same as --no-tui)"}`,
    language: (locale: string, source: string) => `UI language: ${locale} (source ${source})`,
    languageSource: (
      kind: "env" | "cli" | "config" | "locale" | "default",
      name: string | undefined,
      value: string | undefined,
    ): string =>
      kind === "cli"
        ? "--lang"
        : kind === "config"
          ? "ui.language"
          : kind === "default"
            ? "default"
            : `${name}=${value}`,
    proxyTitle: "Proxy",
    fileHistory: (blobs: number, size: string, shadow: string | undefined, dir: string) =>
      `file-history: ${plural(blobs, "backup")}, ${size}${shadow !== undefined ? `; ${shadow}` : ""} (${dir}; ama sessions prune cleans up)`,
    shadowRepos: (repos: number, size: string) => `${plural(repos, "shadow repo")}, ${size}`,
    fileHistoryFailed: (error: string) => `file-history: failed to read (${error})`,
    dirsTitle: "Directories",
    configDir: (path: string) => `Config directory: ${path}`,
    dataDir: (path: string, exists: boolean) =>
      `Data directory: ${path}${exists ? "" : " (not created yet)"}`,
    layersTitle:
      "Config layers (defaults ← user ← profile ← project (tighten only) ← command line)",
    builtinDefaults: "defaults: built in",
    userLevel: "user",
    projectLevel: "project",
    tightened: (text: string) => `  tightened: ${text}`,
    permissionMode: (mode: string) => `Effective permission mode: ${mode}`,
    osSandbox: (kind: string, detail: string, networkOnly: boolean) =>
      `OS sandbox: ${kind === "none" ? "none" : kind} (${detail}${networkOnly ? "; network only" : ""})`,
    bashSandbox: (detail: string) => `bash sandbox: ${detail}`,
    contextTitle: "Context files (AGENTS.md, outer first)",
    contextUser: "user",
    contextProject: "project",
    userHooks: (path: string) => `User hooks.json: ${path}`,
  },
};

export const zh = {
  commands: {
    help: "列出命令",
    new: "新建会话",
    resume: "恢复会话（无 id 时选择）",
    forkArgs: "[条目 id]",
    fork: "从某条目分叉出新会话",
    compactArgs: "[说明]",
    compact: "压缩上下文",
    rewind: "回滚对话与代码到某条消息之前",
    model: "切换模型",
    thinkingArgs: "[级别]",
    thinking: "思考级别 off | minimal | low | medium | high | xhigh",
    permissionArgs: "[模式]",
    permission: "权限模式 plan | default | auto-edit | full-auto",
    toolsArgs: "[名字…]",
    tools: "列出 / 设置活动工具",
    hooks: "列出已加载的 Hook",
    session: "会话信息、用量与缓存",
    cache: "缓存统计；切换本会话保温；打印前缀指纹",
    statusline: "底部信息行两行 / 一行（Ctrl+G）",
    planArgs: "[目标] | approve [模式|fresh] | reject",
    plan: "查看计划与状态；带目标进入 Plan 模式；批准 / 放弃待审批的计划",
    tasks: "子 Agent 任务：状态、输出、停止、转后台",
    agents: "子 Agent 类型与外部 Agent（安装状态、版本）",
    paste: "粘贴剪贴板里的图片（Ctrl+V）",
    exit: "退出",
    config: "设置面板；key=value 直接设一项（用户级）",
    traceArgs: "[任务 id]",
    trace: "轨迹：回合、请求与工具的耗时和用量",
    memoryArgs: "[show|edit|rm <名字> | on|off | reload]",
    memory: "跨会话记忆（需开启 memory.enabled）",
    skillLine: "/skill:<名字> [参数]  使用 Skill",
    templateLine: "/<模板名> [参数]  展开提示模板",
  },
  command: {
    warmingUnsupported: "当前会话不支持切换保温",
    warming: (mode) => `保温：${mode}`,
    warmingInvalid: (modes) => `保温模式应为 ${modes.join(" | ")}`,
    warmingSet: (mode) => `保温：${mode}（本会话）`,
    cacheUsage: "用法：/cache [warm off|streaming|idle | fingerprint]",
    taskStopped: (id) => `已停止 ${id}`,
    tasksUsage: "用法：/tasks [id] | /tasks stop <id> | /tasks bg [id]",
    newSession: (id) => `已新建会话 ${id}`,
    resumed: (id, messages) => `已恢复会话 ${id}（${messages} 条消息）`,
    forked: (id) => `已分叉到新会话 ${id}`,
    compacted: (before, after) =>
      `已压缩：${before}${after !== undefined ? ` → ${after}` : ""} token`,
    model: (ref) => `模型：${ref}`,
    thinkingInvalid: (levels) => `思考级别应为 ${levels.join(" | ")}`,
    thinking: (level) => `思考级别：${level}`,
    permissionInvalid: (modes) =>
      `权限模式应为 ${modes.join(" | ")}（也可写显示名，如 "Accept edits"）`,
    permissionCancelled: (mode) => `已取消，权限模式仍为 ${mode}`,
    permission: (mode) => `权限模式：${mode}`,
    tools: (active, inactive) =>
      `活动：${active.join(", ") || "（无）"}${inactive.length > 0 ? `\n可用：${inactive.join(", ")}` : ""}`,
    noHooks: "没有已加载的 Hook",
    pasted: (path) => `已粘贴图片：${path}`,
    statuslineOnly: "/statusline 只在交互界面可用",
  },
  startup: {
    more: (count) => `  …另有 ${count} 项`,
    trustQuestion: (cwd) => `信任这个目录的项目资源？${cwd}`,
    trustChoices: "[y 仅本次 / a 信任并记住 / N 不信任] ",
    resumeQuestion: "恢复哪个会话？",
    resumeAnswer: "编号或 id：",
    pickModel: "选择模型：",
    pickModelAnswer: "编号或 provider/id：",
    cwdMissing: (path) => `会话的工作目录不存在：${path}`,
    cwdAnswer: "替代目录（空行取消）：",
    notDirectory: (path) => `不是目录：${path}\n`,
  },
  cache: {
    unreported: "未报告",
    unknown: "未知",
    reason: (reason) => {
      switch (reason) {
        case "prefix_changed":
          return "前缀变化";
        case "model_changed":
          return "切换模型";
        case "idle":
          return "空闲超时";
        case "subtask":
          return "子任务";
        case "evicted":
          return "服务端淘汰";
      }
    },
    missIdle: (minutes) => `空闲 ${minutes} 分钟后`,
    missSubtask: (minutes) => `子任务运行 ${minutes} 分钟后`,
    missModel: "切换模型后",
    missTools: "工具表变化",
    missSystem: "系统提示变化",
    missPrefix: "前缀变化",
    missEvicted: "服务端已淘汰",
    missNotice: (reason, tokens, cost) =>
      `缓存未命中（${reason}）：重计费 ${tokens} token${cost === undefined ? "" : `（约 ${cost}）`}`,
    pressure: (percent) => `上下文已用 ${percent}%`,
    pressureTurns: (percent, turns) =>
      `上下文已用 ${percent}%，约剩 ${turns} 回合（按最近 5 回合均值）`,
    pressureTokens: (percent, tokens) => `上下文已用 ${percent}%，余量 ${tokens} token`,
    warmSent: (read, cost) => {
      const text = `${read !== undefined ? `读 ${read} token` : ""}${cost !== undefined ? `${read !== undefined ? "，" : ""}${cost}` : ""}`;
      return `缓存保温已刷新${text !== "" ? `（${text}）` : ""}`;
    },
    stopReason: (reason) =>
      ({
        retention_none: "缓存保留为 none",
        payload_replaced: "请求体被 onPayload 替换",
        thinking_budget: "思考预算随 max_tokens，不可重放",
        reporting_unknown: "端点还没报过缓存",
        reporting_silent: "端点不报缓存",
        no_ttl: "模型目录没有缓存 TTL",
        ttl_too_short: "缓存 TTL 太短",
        max_duration: "已达保温时长上限",
        late: "计时器迟到",
        off: "已关闭",
        stale: "上下文已变",
        declined: "宿主否决",
        error: "保温请求失败",
        no_cache_hits: "连续保温零命中",
        no_price: "缺价格，经济性不可算",
        below_min_savings: "期望节省低于门槛",
      })[reason] ?? reason,
    stopped: "已停止",
    stoppedWith: (reason) => `已停止：${reason}`,
    next: (duration) => `下次 ${duration}`,
    savings: (amount, floor) => `期望节省 ${amount}${floor === undefined ? "" : ` ≥ ${floor}`}`,
    pending: "待下一次请求",
    sent: (count, cost) => `已发 ${count} 次 ${cost}`,
    missesNone: "0 次",
    misses: (count, tokens, cost, by) =>
      `${count} 次，重计费 ${tokens} token ≈ ${cost}${by !== "" ? `（${by}）` : ""}`,
    keyInput: "输入",
    input: (prompt, read, share, uncached, write) =>
      `${prompt} = 缓存读 ${read}${share !== undefined ? `（${share}）` : " "}+ 未缓存 ${uncached}${write !== undefined ? `（其中写入 ${write}）` : ""}`,
    keyHitRate: "命中率",
    sessionRate: (rate) => `会话 ${rate}`,
    rates: (last, session) => `最近 ${last} · 会话 ${session}`,
    keyReporting: "报告状态",
    keyMisses: "未命中",
    keyWarming: "保温",
    keyContext: "上下文",
    context: (percent, remaining, turns) =>
      `${percent}%${remaining !== undefined ? `，余量 ≈ ${remaining} token` : ""}${turns !== undefined ? ` ≈ ${turns} 回合` : ""}`,
    keySubtasks: "子任务",
    subtasks: (count, rate, rebilled) =>
      `${count} 个会话，命中率 ${rate}${rebilled !== undefined ? `，重计费 ${rebilled} token` : ""}`,
    title: "缓存",
  },
  session: {
    externalTokens: (tokens) => `${tokens} token`,
    externalRequests: (count) => `${count} 次请求`,
    external: (runs, amount, tokens) =>
      `${runs} 次运行 · ${amount}${tokens !== undefined ? ` · ${tokens} token` : ""}`,
    tasks: (total) => `${total} 个任务`,
    running: (count) => `运行中 ${count}`,
    status: (status, count) => {
      const labels: Record<string, string> = {
        completed: "完成",
        failed: "失败",
        aborted: "已停止",
        max_turns: "轮数耗尽",
        interrupted: "已中断",
      };
      return `${labels[status] ?? status} ${count}`;
    },
    tasksLine: (parts) => `${parts.join(" · ")}（/tasks）`,
    keySession: "会话",
    session: (id, file) => `${id}${file !== undefined ? `（${file}）` : "（未落盘）"}`,
    keyModel: "模型",
    model: (model, thinking, permission) => `${model} · 思考 ${thinking} · 权限 ${permission}`,
    keyMessages: "消息",
    messages: (user, assistant, tools) => `用户 ${user} · 助手 ${assistant} · 工具调用 ${tools}`,
    keyUsage: "用量",
    usage: (input, output, cacheRead, cacheWrite, cost) =>
      `输入 ${input} · 输出 ${output} · 缓存读 ${cacheRead} · 缓存写 ${cacheWrite} · ${cost}`,
    keyContext: "上下文",
    context: (tokens, window, percent) => `${tokens} / ${window}（${percent}%）`,
    keyAgents: "子 Agent",
    externalTitle: "外部 Agent",
    noFingerprint: "当前会话不提供前缀指纹",
    noRequestYet: "还没有真实请求（指纹在第一次请求后记录）",
    fingerprintTitle: "前缀指纹（最近一次请求）",
  },
  doctor: {
    usage: "用法：ama doctor [--profile <文件>] [--auth-file <文件>] [--trust | --no-trust]\n",
    missing: (label, path) => `${label}：${path}（不存在）`,
    labeled: (label, text) => `${label}：${text}`,
    keySource: (source, origin) => `${source}${origin !== undefined ? `（${origin}）` : ""}`,
    hookCommand: (command, ms) => `${command}（${ms} ms）`,
    codemode: (mode, reason) => `codemode：${mode}（${reason}）`,
    warning: (text) => `警告：${text}`,
    trustTitle: "信任",
    fromCli: "命令行",
    noRecord: "缺省：无记录，交互模式会询问",
    trustInvalid: "trust.json 无效",
    trust: (cwd, trusted, from) => `${cwd}：${trusted ? "已信任" : "未信任"}（${from}）`,
    gated: (trusted) => `需要信任的资源${trusted ? "" : "（当前不加载）"}：`,
    keysTitle: "Key 来源（只显示来源，不显示值）",
    authMode: (mode, path) => `auth.json 权限 ${mode}，应为 600：${path}`,
    none: "无",
    notNeeded: "无需",
    baseUrlEnv: (env, url) => `baseUrl 来自环境变量 ${env}：${url}（compat 按保守缺省）`,
    model: (ref, reason) => `将使用的模型：${ref ?? "（无）"}（${reason}）`,
    registry: (error) => `供应商注册表：${error}`,
    envVars: (names) => `环境变量：${names.length > 0 ? names.join(", ") : "（无）"}`,
    empty: "（无）",
    hookSkipped: (path) => `未信任，跳过：${path}`,
    terminalTitle: "终端",
    tty: (stdin, stdout) =>
      `stdin TTY：${stdin ? "是" : "否"} · stdout TTY：${stdout ? "是" : "否"}`,
    term: (term, colorterm) =>
      `TERM=${term ?? "（未设置）"} · COLORTERM=${colorterm ?? "（未设置）"}`,
    noColor: "NO_COLOR 已设置：不输出颜色",
    tmux: "在 tmux 中运行",
    size: (columns, rows) => `尺寸：${columns}×${rows}`,
    defaultUi: (tui) => `缺省界面：${tui ? "终端界面" : "行式（--no-tui 等价）"}`,
    language: (locale, source) => `界面语言：${locale}（来源 ${source}）`,
    languageSource: (kind, name, value) =>
      kind === "cli"
        ? "--lang"
        : kind === "config"
          ? "ui.language"
          : kind === "default"
            ? "缺省"
            : `${name}=${value}`,
    proxyTitle: "代理",
    fileHistory: (blobs, size, shadow, dir) =>
      `file-history：${blobs} 个备份，${size}${shadow !== undefined ? `；${shadow}` : ""}（${dir}；ama sessions prune 清理）`,
    shadowRepos: (repos, size) => `影子仓库 ${repos} 个，${size}`,
    fileHistoryFailed: (error) => `file-history：读取失败（${error}）`,
    dirsTitle: "目录",
    configDir: (path) => `配置目录：${path}`,
    dataDir: (path, exists) => `数据目录：${path}${exists ? "" : "（尚未创建）"}`,
    layersTitle: "配置层级（缺省 ← 用户级 ← profile ← 项目级（只能收紧）← 命令行）",
    builtinDefaults: "缺省：内置",
    userLevel: "用户级",
    projectLevel: "项目级",
    tightened: (text) => `  收紧：${text}`,
    permissionMode: (mode) => `有效权限模式：${mode}`,
    osSandbox: (kind, detail, networkOnly) =>
      `操作系统沙箱：${kind === "none" ? "无" : kind}（${detail}${networkOnly ? "；只隔离网络" : ""}）`,
    bashSandbox: (detail) => `bash 沙箱：${detail}`,
    contextTitle: "上下文文件（AGENTS.md，外层在前）",
    contextUser: "用户级",
    contextProject: "项目",
    userHooks: (path) => `用户级 hooks.json：${path}`,
  },
} satisfies Messages<typeof en>;
