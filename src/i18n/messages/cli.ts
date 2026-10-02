/**
 * 消息目录：cli（键名规范见 docs/i18n.md）。[W6-C0 建空壳，W6-I1 迁入 `src/cli/**` 的界面文案]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * `--help` 全文较长，单独放在 `cli-help.ts`。
 */

import type { Messages } from "../types.js";
import * as help from "./cli-help.js";
import * as args from "./cli-args.js";

export const en = {
  args: args.en,
  main: {
    subcommandUnavailable: (name: string) => `ama ${name}: not available in this build yet`,
    uncaught: (message: string) => `ama: uncaught exception: ${message}\n`,
  },
  help: help.en.text,
  /** 退出码说明（数值是契约，不译；键是 `ExitCode` 的名字）。 */
  exitCodes: {
    ok: "OK",
    runtimeError: "Runtime error (model ultimately failed, etc.)",
    usage: "Invalid arguments",
    config: "Config / profile / path error",
    noModel: "No usable model or key",
    session: "Session missing / corrupt / cwd mismatch",
    hostOrHook: "Host / hook failed to load or start",
    toolDenied: "-p: a tool call was denied during the run (no one to approve)",
    limitReached: "-p reached a budget limit (--max-turns / --max-cost / limits)",
    planPending: "-p saved a plan that awaits approval (not executed)",
    hostVersion: "HOST_API_VERSION mismatch",
    sigint: "Exited on SIGINT (Ctrl+C twice)",
    sigterm: "SIGTERM",
    unknown: "Unknown exit code",
  },
  bootstrap: {
    /** 启动步骤名（失败时作为前缀：`<步骤>：<原因>`）。 */
    steps: {
      dirs: "directories",
      config: "config",
      sessionList: "session list",
      session: "session",
      trust: "trust",
      projectConfig: "project config",
      skillDiscovery: "skill discovery",
      providers: "providers",
      model: "model",
      tools: "tools",
      host: "host adapter",
      permission: "permissions",
      assembly: "session assembly",
      startup: "startup",
    },
    resumeNeedsId: "--resume needs a session id in non-interactive mode",
    noSessionPicked: "No session selected",
    sessionCwdMissing: (cwd: string) => `The session's working directory does not exist: ${cwd}`,
    unknownDisabledTool: (name: string) => `config tools.disabled: unknown tool ${name}, ignored`,
    eventWarning: (message: string, detail?: string) =>
      detail === undefined ? message : `${message}: ${detail}`,
    sessionNotReady: "Session is not ready yet",
    hostDisposeFailed: (error: string) => `Host adapter dispose failed: ${error}`,
    sessionStartBlocked: (reason?: string) =>
      `SessionStart hook blocked startup: ${reason ?? "(no reason given)"}`,
    subcommandNotDispatched: "Subcommands should be dispatched by main",
    runtimeNotAssembled:
      "ama: runtime not assembled (the integration batch injects it via registerRuntimeDeps)\n",
    warning: (text: string) => `ama: warning: ${text}\n`,
    modeNotAssembled: (mode: string) => `Mode ${mode} is not assembled yet`,
    terminalFallback: (message: string) =>
      `ama: warning: terminal initialization failed, falling back to the line UI (${message})\n`,
    usageError: (message: string) => `ama: ${message}\n(see ama --help for usage)\n`,
  },
  startupSteps: {
    stepFailed: (label: string, message: string) => `${label}: ${message}`,
    providerNeedsModel: (provider: string) =>
      `--provider ${provider} also needs --model (it does not fall back to the provider's default model)`,
    noApiKey: (provider: string, envKeys: readonly string[]) =>
      `Provider ${provider} has no API key: run \`ama auth set ${provider}\`` +
      (envKeys.length > 0 ? `, or set the environment variable ${envKeys.join(" / ")}` : ""),
    unknownTools: (unknown: readonly string[], available: readonly string[]) =>
      `Unknown tools: ${unknown.join(", ")} (available: ${available.join(", ")})`,
    instructionsMissing: (path: string) => `--instructions file does not exist: ${path}`,
  },
  startupScreen: {
    header: (version: string) =>
      `ama ${version} · Enter send · Esc interrupt · Ctrl+C twice to quit · /help commands`,
    model: (ref: string, thinking: string) => `Model: ${ref} · thinking ${thinking}`,
    cwd: (cwd: string, trust: string) => `Directory: ${cwd} · ${trust}`,
    context: (paths: readonly string[]) => `Context: ${paths.join(", ")}`,
    skills: (names: readonly string[]) => `Skills: ${names.join(", ")}`,
    prompts: (names: readonly string[]) => `Prompt templates: ${names.join(" ")}`,
    hooks: (n: number) => `Hooks: ${n}`,
    host: (id: string) => `Host: ${id}`,
    warnings: (n: number) => `Warnings: ${n} (see ama doctor)`,
    trust: (trusted: boolean, from: string) => `${trusted ? "trusted" : "untrusted"} (${from})`,
    /** 信任来源的短名。 */
    trustSource: {
      flag: "command line",
      trustFile: "trust.json",
      prompt: "confirmed this time",
      profile: "profile",
      default: "default",
    },
  },
  proxy: {
    unparsable: (url: string) => `cannot parse ${url}`,
    unsupportedHint: (nodeVersion: string) =>
      `ama: HTTPS_PROXY / HTTP_PROXY is set, but fetch in Node ${nodeVersion} ignores proxy variables; requests go direct. ` +
      "Upgrade to Node 24+, or set NODE_USE_ENV_PROXY=1 on Node 22.21+\n",
    invalidHint: (error: string) =>
      `ama: cannot parse the proxy variables; requests go direct: ${error}\n`,
    state: {
      none: "No proxy variables set: direct connection",
      runtime: "Enabled (Node handles it via NODE_USE_ENV_PROXY / --use-env-proxy)",
      enabled: "Enabled (ama calls Node's built-in setGlobalProxyFromEnv at startup)",
      unsupported: (nodeVersion: string) =>
        `✗ Node ${nodeVersion} has no built-in proxy support; requests go direct. Upgrade to Node 24+`,
      invalid: (error: string) => `✗ Cannot parse the proxy variables: ${error}`,
    },
  },
  defaultModel: {
    priceReason: (inputCost: number, context: string) =>
      `Lowest input price among models with tool calling, context ≥ 64k and known prices ($${inputCost}/M input, context ${context})`,
    builtinFirst: "First model recommended by the built-in catalog",
    listFirst:
      "First model in the list (no model has tool calling, context ≥ 64k and known prices at once)",
    noModel: (envs: string, more: boolean) =>
      `No usable model: set the environment variable ${envs}${more ? " or similar" : ""}, ` +
      "save a key with `ama auth set <provider>`, or connect a relay with " +
      "`ama providers add <id> --base-url <url>` (--model also works)",
  },
  choicePrompt: {
    hint: (keys: string, n: number) => `${keys} select · Enter confirm · 1-${n} pick · Esc cancel`,
    cancelled: "(cancelled)",
    continueQuestion: "Continue?",
    continue: "Continue",
    cancel: "Cancel",
    textQuestion: (question: string) => `${question} [y/N] `,
  },
  fromPrompt: {
    notWithRpc: "--from cannot be used with --mode rpc",
    imagesDropped: (n: number) =>
      `ama: the --from message has ${n} image(s); the interactive UI only takes the text (-p sends them too)\n`,
  },
  systemPrompt: {
    fileMissing: (path: string) => `--system-prompt file does not exist: ${path}`,
    empty: "--system-prompt is empty",
  },
  codemodeNotice: (nodeMajor: number) =>
    `Node ${nodeMajor} < 25 and no OS sandbox available: the codemode sandbox has no network isolation, so codemode is off by default; ` +
    "turn it on with `--codemode on` or codemode.mode in config (shown once per config directory)",
  compose: {
    toolFactoryFailed: (message: string) => `Tool factory failed: ${message}`,
    toolRegisterFailed: (name: string, message: string) =>
      `Failed to register tool ${name}: ${message}`,
    permissionRuleIgnored: (source: string, message: string) =>
      `Permission rule (${source}): ${message}, ignored`,
    untrustedDirsSkipped: (n: number) =>
      `${n} project-level director${n === 1 ? "y was" : "ies were"} skipped because the project is not trusted (load with --trust)`,
  },
  composeSession: {
    instructionsReadFailed: (path: string, message: string) =>
      `Failed to read instruction file: ${path}: ${message}`,
    unknownSkill: (name: string, available: readonly string[]) =>
      `Unknown skill: ${name}` +
      (available.length > 0 ? ` (available: ${available.join(", ")})` : ""),
    invalidCacheWarming: (value: string) =>
      `AMA_CACHE_WARMING=${value} is invalid (off | streaming | idle), ignored`,
    invalidCacheRetention: (value: string) =>
      `AMA_CACHE_RETENTION=${value} is invalid (none | short | long), ignored`,
    invalidIdleTimeout: (value: string) =>
      `AMA_IDLE_TIMEOUT_MS=${value} is invalid (expected milliseconds ≥ 0), ignored`,
    notSessionManager:
      "The composition root only accepts SessionManager instances (created by sessions.open)",
    apiNotImplemented: (ref: string, api: string, viaOpenrouter: boolean) =>
      `Protocol ${api} of model ${ref} is not implemented yet` +
      (viaOpenrouter ? "; go through openrouter for now" : ""),
    appendToolFailed: (name: string, message: string) =>
      `Failed to append tool ${name}: ${message}`,
    notComposed: "This session was not created by the composition root and cannot be switched",
    switchWhileStreaming: "Cannot switch sessions while a run is in progress",
  },
  composeStore: {
    ambiguousId: (id: string, candidates: readonly string[]) =>
      `Session id prefix ${id} is ambiguous, candidates: ${candidates.join(", ")}`,
    sessionNotFound: (id: string) => `Session not found: ${id}`,
    noEntries: (id: string) => `Session ${id} has no entries`,
    unreadable: (file: string) => `Cannot read session file: ${file}`,
  },
  composeAgents: {
    untrustedAgentDir: (dir: string) =>
      `Project not trusted; skipped subagent definition directory ${dir} (takes effect with --trust)`,
  },
};

export const zh = {
  args: args.zh,
  main: {
    subcommandUnavailable: (name) => `ama ${name}：当前版本尚未提供`,
    uncaught: (message) => `ama: 未捕获的异常：${message}\n`,
  },
  help: help.zh.text,
  exitCodes: {
    ok: "正常",
    runtimeError: "运行期错误（模型最终失败等）",
    usage: "参数用法错误",
    config: "配置 / profile / 路径错误",
    noModel: "无可用模型或密钥",
    session: "会话不存在 / 损坏 / cwd 不匹配",
    hostOrHook: "宿主 / Hook 加载或启动失败",
    toolDenied: "-p 运行中有工具调用被拒（没有人审批）",
    limitReached: "-p 到达预算上限（--max-turns / --max-cost / limits）",
    planPending: "-p 产出的计划已落盘、待审批（未执行）",
    hostVersion: "HOST_API_VERSION 不匹配",
    sigint: "SIGINT 退出（两次 Ctrl+C）",
    sigterm: "SIGTERM",
    unknown: "未知退出码",
  },
  bootstrap: {
    steps: {
      dirs: "目录",
      config: "配置",
      sessionList: "会话列表",
      session: "会话",
      trust: "信任",
      projectConfig: "项目配置",
      skillDiscovery: "Skill 发现",
      providers: "供应商",
      model: "模型",
      tools: "工具",
      host: "宿主适配器",
      permission: "权限",
      assembly: "会话组装",
      startup: "启动",
    },
    resumeNeedsId: "--resume 在非交互模式下需要会话 id",
    noSessionPicked: "未选择会话",
    sessionCwdMissing: (cwd) => `会话的工作目录不存在：${cwd}`,
    unknownDisabledTool: (name) => `config tools.disabled：未知工具 ${name}，已忽略`,
    eventWarning: (message, detail) => (detail === undefined ? message : `${message}：${detail}`),
    sessionNotReady: "会话尚未就绪",
    hostDisposeFailed: (error) => `宿主适配器 dispose 失败：${error}`,
    sessionStartBlocked: (reason) => `SessionStart Hook 阻止启动：${reason ?? "（无原因）"}`,
    subcommandNotDispatched: "子命令应由 main 分派",
    runtimeNotAssembled: "ama: 运行时尚未装配（集成批次通过 registerRuntimeDeps 注入实现）\n",
    warning: (text) => `ama: 警告：${text}\n`,
    modeNotAssembled: (mode) => `模式 ${mode} 尚未装配`,
    terminalFallback: (message) => `ama: 警告：终端初始化失败，降级为行式界面（${message}）\n`,
    usageError: (message) => `ama: ${message}\n（ama --help 查看用法）\n`,
  },
  startupSteps: {
    stepFailed: (label, message) => `${label}：${message}`,
    providerNeedsModel: (provider) =>
      `--provider ${provider} 需要同时给出 --model（不回退到该供应商的缺省模型）`,
    noApiKey: (provider, envKeys) =>
      `供应商 ${provider} 没有 API key：运行 \`ama auth set ${provider}\`` +
      (envKeys.length > 0 ? `，或设置环境变量 ${envKeys.join(" / ")}` : ""),
    unknownTools: (unknown, available) =>
      `未知工具：${unknown.join(", ")}（可用：${available.join(", ")}）`,
    instructionsMissing: (path) => `--instructions 文件不存在：${path}`,
  },
  startupScreen: {
    header: (version) => `ama ${version} · Enter 发送 · Esc 中断 · Ctrl+C 两次退出 · /help 命令`,
    model: (ref, thinking) => `模型：${ref} · 思考 ${thinking}`,
    cwd: (cwd, trust) => `目录：${cwd} · ${trust}`,
    context: (paths) => `上下文：${paths.join(", ")}`,
    skills: (names) => `Skill：${names.join(", ")}`,
    prompts: (names) => `提示模板：${names.join(" ")}`,
    hooks: (n) => `Hook：${n} 条`,
    host: (id) => `宿主：${id}`,
    warnings: (n) => `警告：${n} 条（ama doctor 查看）`,
    trust: (trusted, from) => `${trusted ? "已信任" : "未信任"}（${from}）`,
    trustSource: {
      flag: "命令行",
      trustFile: "trust.json",
      prompt: "本次确认",
      profile: "profile",
      default: "缺省",
    },
  },
  proxy: {
    unparsable: (url) => `无法解析 ${url}`,
    unsupportedHint: (nodeVersion) =>
      `ama: 检测到 HTTPS_PROXY / HTTP_PROXY，但 Node ${nodeVersion} 的 fetch 不读代理变量，请求将直连；` +
      "升级到 Node 24+，或在 Node 22.21+ 上设 NODE_USE_ENV_PROXY=1\n",
    invalidHint: (error) => `ama: 代理变量无法解析，请求将直连：${error}\n`,
    state: {
      none: "未设置代理变量：直连",
      runtime: "已启用（Node 按 NODE_USE_ENV_PROXY / --use-env-proxy 接管）",
      enabled: "已启用（ama 启动时调用 Node 内置的 setGlobalProxyFromEnv）",
      unsupported: (nodeVersion) =>
        `✗ 当前 Node ${nodeVersion} 不支持内置代理，请求直连；升级到 Node 24+`,
      invalid: (error) => `✗ 代理变量无法解析：${error}`,
    },
  },
  defaultModel: {
    priceReason: (inputCost, context) =>
      `支持工具调用、上下文 ≥ 64k 且有价格的模型里输入价最低（$${inputCost}/M 输入，上下文 ${context}）`,
    builtinFirst: "内置目录推荐的首个模型",
    listFirst: "列表首个模型（没有同时支持工具调用、上下文 ≥ 64k 且有价格的模型）",
    noModel: (envs, more) =>
      `没有可用模型：设置 ${envs}${more ? " 等" : ""}环境变量，或 \`ama auth set <provider>\` 保存 key，` +
      "或 `ama providers add <id> --base-url <url>` 接入中转站（也可 --model 指定）",
  },
  choicePrompt: {
    hint: (keys, n) => `${keys} 选择 · Enter 确认 · 1-${n} 直接选 · Esc 取消`,
    cancelled: "（已取消）",
    continueQuestion: "继续？",
    continue: "继续",
    cancel: "取消",
    textQuestion: (question) => `${question}[y/N] `,
  },
  fromPrompt: {
    notWithRpc: "--from 不用于 --mode rpc",
    imagesDropped: (n) => `ama: --from 的消息带 ${n} 张图片，交互界面只带文本（-p 会一并发送）\n`,
  },
  systemPrompt: {
    fileMissing: (path) => `--system-prompt 文件不存在：${path}`,
    empty: "--system-prompt 的内容为空",
  },
  codemodeNotice: (nodeMajor) =>
    `Node ${nodeMajor} < 25 且没有可用的操作系统沙箱：codemode 沙箱的网络未隔离，codemode 缺省关闭；` +
    "用 `--codemode on` 或 config 的 codemode.mode 开启（每个配置目录只提示一次）",
  compose: {
    toolFactoryFailed: (message) => `工具工厂失败：${message}`,
    toolRegisterFailed: (name, message) => `工具 ${name} 注册失败：${message}`,
    permissionRuleIgnored: (source, message) => `权限规则（${source}）：${message}，已忽略`,
    untrustedDirsSkipped: (n) => `${n} 个项目级目录因未信任被跳过（--trust 加载）`,
  },
  composeSession: {
    instructionsReadFailed: (path, message) => `读取指令文件失败：${path}：${message}`,
    unknownSkill: (name, available) =>
      `未知 Skill：${name}` + (available.length > 0 ? `（可用：${available.join(", ")}）` : ""),
    invalidCacheWarming: (value) =>
      `AMA_CACHE_WARMING=${value} 无效（off | streaming | idle），已忽略`,
    invalidCacheRetention: (value) =>
      `AMA_CACHE_RETENTION=${value} 无效（none | short | long），已忽略`,
    invalidIdleTimeout: (value) =>
      `AMA_IDLE_TIMEOUT_MS=${value} 无效（应为不小于 0 的毫秒数），已忽略`,
    notSessionManager: "组装根只接受 SessionManager 实例（由 sessions.open 创建）",
    apiNotImplemented: (ref, api, viaOpenrouter) =>
      `模型 ${ref} 的协议 ${api} 尚未实现` + (viaOpenrouter ? "；过渡期请经 openrouter 调用" : ""),
    appendToolFailed: (name, message) => `追加工具 ${name} 失败：${message}`,
    notComposed: "该会话不是由组装根创建的，不能切换",
    switchWhileStreaming: "运行中不能切换会话",
  },
  composeStore: {
    ambiguousId: (id, candidates) => `会话 id 前缀 ${id} 不唯一，候选：${candidates.join(", ")}`,
    sessionNotFound: (id) => `会话不存在：${id}`,
    noEntries: (id) => `会话 ${id} 没有条目`,
    unreadable: (file) => `会话文件无法读取：${file}`,
  },
  composeAgents: {
    untrustedAgentDir: (dir) => `项目未信任，跳过子 Agent 定义目录 ${dir}（--trust 后生效）`,
  },
} satisfies Messages<typeof en>;
