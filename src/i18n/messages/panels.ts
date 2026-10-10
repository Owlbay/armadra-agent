/**
 * 消息目录：panels（键名规范见 docs/guides/i18n.md）。[W6-C0 建空壳，归 W6-I2]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 *
 * 消息区面板与选择器：`/session`、`/cache`、`/permissions`（`panels.ts`）、选择器（`pickers.ts`）、
 * `/plan` 面板、`/agents`、`/tasks`（`agent-panels.ts`、`tasks-report.ts`）。句中需要另一种颜色的部分由调用方
 * 传入 `dim` 之类的着色函数，整句仍在一个键里。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

type Paint = (text: string) => string;

export const en = {
  session: {
    title: (id: string) => `Session ${id}`,
    notSaved: "not saved",
    model: "Model",
    thinking: (level: string) => `thinking ${level}`,
    permission: (mode: string) => `permissions ${mode}`,
    messages: "Messages",
    user: (n: number) => `user ${n}`,
    assistant: (n: number) => `assistant ${n}`,
    toolCalls: (n: number) => `tool calls ${n}`,
    usage: "Total usage",
    input: (tokens: string) => `input ${tokens}`,
    output: (tokens: string) => `output ${tokens}`,
    cacheRead: (tokens: string) => `cache read ${tokens}`,
    cacheWrite: (tokens: string) => `cache write ${tokens}`,
    context: "Context",
    subagents: "Subagents",
    external: "External agents",
  },
  cache: {
    title: "Cache",
  },
  permissions: {
    mode: "Mode",
    modeValue: (label: string, mode: string, dim: Paint) => `${label}${dim(` (${mode})`)}`,
    order: "Order",
    orderAuto:
      "deny rules → Hook deny → dangerous-command confirmation → rule layer (protected paths, writes outside the project, network, deletions) → Hook ask → allow rules / Hook allow / session memory → static check (read-only, in-project writes, safe list) → model classifier → ask",
    orderAllowlist:
      "deny rules → Hook deny → dangerous commands (denied) → read-only tools / allow rules / Hook allow pass → everything else denied (never asks)",
    orderDefault:
      "deny rules → Hook deny → dangerous-command confirmation → permission mode → allow rules / Hook allow / session memory → ask",
    rulesNone: "Rules (none)",
    rules: (n: number) => `Rules (${n})`,
    recentAuto: (n: number) => `Recent auto decisions (${n})`,
    cached: " (cached)",
  },
  picker: {
    footer: (arrows: string) => `${arrows} select · Enter confirm · Esc cancel`,
    permissionTitle: "Permission mode",
    permissionFooter: (arrows: string) =>
      `${arrows} select · 1-6 pick · Enter confirm · Esc cancel`,
    thinkingUnsupported: "The current model does not support thinking",
    emptyText: "(empty)",
  },
  /** 模型选择器（`/model`、启动选择器、`/config` 的模型项）。 */
  model: {
    local: "local",
    key: "key ✓",
    oauth: "signed in ✓",
    needsLogin: "sign in again",
    noKey: "no key configured",
    current: "current",
    listed: "listed",
    otherChannels: (names: string) => `also ${names}`,
    discoverHint: (provider: string) => `Run ama models discover ${provider} to list its models`,
    loginHint: (provider: string) => `Run ama auth login ${provider} to sign in`,
    footerConfigured: "Tab all · Space list · @ channels · Enter switch · Esc cancel",
    footerAll: "Tab configured · Space list · @ channels · Enter switch · Esc cancel",
    emptyConfigured: "(no configured models; Tab shows all)",
    added: (ref: string) => `Added ${ref} to models.enabled`,
    addedFirst: (ref: string) =>
      `Added ${ref} to models.enabled; /model now shows only listed models (Tab shows all)`,
    removed: (ref: string) => `Removed ${ref} from models.enabled`,
    wildcard: (ref: string, pattern: string) =>
      `${ref} is listed through ${pattern}; remove it with ama models disable ${pattern}`,
    noKeyHint: (provider: string) =>
      `${provider} has no key: run ama auth set ${provider} (custom providers: ama providers add)`,
    needsLoginHint: (provider: string) =>
      `${provider} needs a new sign-in: run ama auth login ${provider}`,
  },
  plan: {
    title: "Plan",
    titleVersion: (version: number) => `Plan v${version}`,
    status: "Status",
    mode: "Mode",
    modePlan: (back: string, dim: Paint) => `Plan${dim(` (returns to ${back} after approval)`)}`,
    todos: "Todos",
    todosValue: (done: number, total: number, current: string | undefined, dim: Paint) =>
      `${done}/${total} done${current !== undefined ? dim(` · in progress ${current}`) : ""}`,
    steps: (n: number) => `Steps (${n})`,
  },
  agents: {
    title: "Subagents",
    titleCount: (n: number) => `Subagents (${n})`,
    none: "This session has no subagents (the task tool is not enabled)",
    typesHeading: (n: number) => `Subagent types (${n}):`,
    source: {
      builtin: "built-in",
      cli: "command line",
      profile: "profile",
      user: "user",
      project: "project",
      host: "host",
    },
    notInstalled: "not installed",
    installed: (version: string | undefined) =>
      version !== undefined ? `installed ${version}` : "installed",
  },
  tasks: {
    status: {
      running: "running",
      completed: "done",
      failed: "failed",
      aborted: "stopped",
      max_turns: "out of turns",
      interrupted: "interrupted",
    },
    turns: (n: number) => plural(n, "turn"),
    /** 外部 Agent 报告的上下文占用（`34%`、`0.4%`）。 */
    context: (percent: string) => `ctx ${percent}`,
    agentRunner: (agent: string, runner: string) => `${agent} (${runner})`,
    background: "background",
    none: "No subagent tasks yet",
    heading: (n: number) => `Subagent tasks (${n}):`,
    footer: "/tasks <id> to view output · /tasks stop <id> to stop",
    notFound: (id: string) => `No task ${id}`,
    fullOutput: (path: string) => `Full output: ${path}`,
    noOutput: "(no output yet)",
    title: (id: string) => `Task ${id}`,
  },
};

export const zh = {
  session: {
    title: (id) => `会话 ${id}`,
    notSaved: "未落盘",
    model: "模型",
    thinking: (level) => `思考 ${level}`,
    permission: (mode) => `权限 ${mode}`,
    messages: "消息",
    user: (n) => `用户 ${n}`,
    assistant: (n) => `助手 ${n}`,
    toolCalls: (n) => `工具调用 ${n}`,
    usage: "累计用量",
    input: (tokens) => `输入 ${tokens}`,
    output: (tokens) => `输出 ${tokens}`,
    cacheRead: (tokens) => `缓存读 ${tokens}`,
    cacheWrite: (tokens) => `缓存写 ${tokens}`,
    context: "上下文",
    subagents: "子 Agent",
    external: "外部 Agent",
  },
  cache: {
    title: "缓存",
  },
  permissions: {
    mode: "权限模式",
    modeValue: (label, mode, dim) => `${label}${dim(`（${mode}）`)}`,
    order: "判定顺序",
    orderAuto:
      "deny 规则 → Hook deny → 危险命令确认 → 规则层（受保护路径、项目外写入、网络、删除类）→ Hook ask → allow 规则 / Hook allow / 本会话记忆 → 静态判定（只读、项目内写入、安全名单）→ 模型分类器 → 询问",
    orderAllowlist:
      "deny 规则 → Hook deny → 危险命令（拒绝）→ 只读工具 / allow 规则 / Hook allow 放行 → 其余拒绝（从不询问）",
    orderDefault:
      "deny 规则 → Hook deny → 危险命令确认 → 权限模式 → allow 规则 / Hook allow / 本会话记忆 → 询问",
    rulesNone: "规则（无）",
    rules: (n) => `规则（${n}）`,
    recentAuto: (n) => `最近的 auto 判定（${n}）`,
    cached: "（缓存）",
  },
  picker: {
    footer: (arrows) => `${arrows} 选择 · Enter 确认 · Esc 取消`,
    permissionTitle: "权限模式",
    permissionFooter: (arrows) => `${arrows} 选择 · 1-6 直接选 · Enter 确认 · Esc 取消`,
    thinkingUnsupported: "当前模型不支持思考",
    emptyText: "（空）",
  },
  model: {
    local: "本地",
    key: "key ✓",
    oauth: "已登录 ✓",
    needsLogin: "需重新登录",
    noKey: "未配置 key",
    current: "当前",
    listed: "清单内",
    otherChannels: (names) => `另有 ${names}`,
    discoverHint: (provider) => `运行 ama models discover ${provider} 获取模型`,
    loginHint: (provider) => `运行 ama auth login ${provider} 登录`,
    footerConfigured: "Tab 全部 · Space 清单 · @ 渠道 · Enter 切换 · Esc 取消",
    footerAll: "Tab 已配置 · Space 清单 · @ 渠道 · Enter 切换 · Esc 取消",
    emptyConfigured: "（没有已配置的模型，Tab 看全部）",
    added: (ref) => `已把 ${ref} 加入 models.enabled`,
    addedFirst: (ref) =>
      `已把 ${ref} 加入 models.enabled；/model 之后只显示清单内的模型（Tab 看全部）`,
    removed: (ref) => `已把 ${ref} 移出 models.enabled`,
    wildcard: (ref, pattern) =>
      `${ref} 经 ${pattern} 列入清单；用 ama models disable ${pattern} 移除`,
    noKeyHint: (provider) =>
      `${provider} 未配置 key：运行 ama auth set ${provider}（自定义供应商用 ama providers add）`,
    needsLoginHint: (provider) => `${provider} 需要重新登录：运行 ama auth login ${provider}`,
  },
  plan: {
    title: "计划",
    titleVersion: (version) => `计划 v${version}`,
    status: "状态",
    mode: "模式",
    modePlan: (back, dim) => `Plan${dim(`（批准后回到 ${back}）`)}`,
    todos: "待办",
    todosValue: (done, total, current, dim) =>
      `${done}/${total} 完成${current !== undefined ? dim(` · 进行中 ${current}`) : ""}`,
    steps: (n) => `步骤（${n}）`,
  },
  agents: {
    title: "子 Agent",
    titleCount: (n) => `子 Agent（${n}）`,
    none: "当前会话没有子 Agent（task 工具未启用）",
    typesHeading: (n) => `子 Agent 类型（${n}）：`,
    source: {
      builtin: "内置",
      cli: "命令行",
      profile: "profile",
      user: "用户",
      project: "项目",
      host: "宿主",
    },
    notInstalled: "未安装",
    installed: (version) => (version !== undefined ? `已安装 ${version}` : "已安装"),
  },
  tasks: {
    status: {
      running: "运行中",
      completed: "完成",
      failed: "失败",
      aborted: "已停止",
      max_turns: "轮数耗尽",
      interrupted: "已中断",
    },
    turns: (n) => `${n} 轮`,
    context: (percent) => `ctx ${percent}`,
    agentRunner: (agent, runner) => `${agent}（${runner}）`,
    background: "后台",
    none: "还没有子 Agent 任务",
    heading: (n) => `子 Agent 任务（${n}）：`,
    footer: "/tasks <id> 查看输出 · /tasks stop <id> 停止",
    notFound: (id) => `没有任务 ${id}`,
    fullOutput: (path) => `全文：${path}`,
    noOutput: "（还没有输出）",
    title: (id) => `任务 ${id}`,
  },
} satisfies Messages<typeof en>;
