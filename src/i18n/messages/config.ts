/**
 * 消息目录：config（键名规范见 docs/guides/i18n.md）。[W6-C0 建空壳，W6-I4 迁入]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * 配置键说明（`keys` / `dynamicDefaults`）体量大，放在 `config-keys.ts`，经 `keyDoc(path)` 取用。
 */

import type { Messages } from "../types.js";
import * as keyDocs from "./config-keys.js";

export const en = {
  /** 配置校验诊断（checker.ts、schema.ts、schema-w5.ts、schema-w6.ts）。 */
  schema: {
    enumArray: (choices: readonly string[]) => `should be an array of ${choices.join(" | ")}`,
    ports: "should be an array of port numbers (0–65535; 0 = any free port)",
    required: "required",
    memoryDir: "memory.enabled is true but memory.dir is not an absolute path",
    object: "should be an object",
    unknownKey: "unknown field, ignored",
    version: "version must be 1",
    requiredString: "required string missing",
    string: "should be a string",
    boolean: "should be a boolean",
    number: "should be a number",
    range: (min: number, max: number) => `should be between ${min} and ${max}`,
    oneOf: (choices: readonly string[]) => `should be one of ${choices.join(" | ")}`,
    stringArray: "should be an array of strings",
    array: "should be an array",
    modelsDev: `should be "provider/model" or false`,
    catalog: `should be "provider/model" or false`,
    modelsEnabled: `should be "provider/model[@channel]" or "provider/*"`,
    noChannels: "the provider has no channels",
    unknownChannelOf: (name: string, available: readonly string[]) =>
      `channel "${name}" does not exist (available: ${available.join(", ")})`,
    modelInput: `should be ("text" | "image")[]`,
    channelName:
      "channel names may only contain letters, digits, _ and - (no / or @), at most 32 characters",
    atLeastOneChannel: "at least one channel is required",
    unknownChannel: (name: string) => `channel "${name}" does not exist`,
    defaultChannelWithoutChannels: "defaultChannel cannot be set without channels",
    builtinDeny: "should be a boolean or an array of strings",
    writablePath: "should be an absolute path or ~/…; ignored",
    providersMissing: "providers missing",
    hookEvent: (events: readonly string[]) => `unknown event (available: ${events.join(", ")})`,
    hookType: `type must be "command"`,
    hookCommandEmpty: "command is empty",
    clearAtLeast: 'should be "auto" or a non-negative number',
    agentId: "agent ids may only contain lowercase letters, digits, - . _ (optional acp: prefix)",
  },
  /** 层级合并（merge.ts）的告警。 */
  merge: {
    projectIgnored: (label: string, key: string) =>
      `${label}: ${key} cannot be set at project level; ignored`,
    projectMemoryOnlyDisable: (label: string) =>
      `${label}: project level can only set memory.enabled to false; other memory keys ignored`,
    projectOnlyKeys: (label: string, allowed: string, ignored: string) =>
      `${label}: project level can only set ${allowed}; ignoring ${ignored}`,
    projectPresetLoosen: (label: string, preset: string, current: string) =>
      `${label}: project level cannot loosen the tool preset; ignoring tools.preset ${preset} (current ${current})`,
    projectOnlyValue: (label: string, key: string, value: string, ignored: string) =>
      `${label}: project level only accepts ${key} "${value}"; ignoring ${ignored}`,
    projectPlanBashTighten: (label: string, value: string, current: string) =>
      `${label}: project level can only tighten plan.bash; ignoring ${value} (current ${current})`,
    projectModeTighten: (label: string, value: string, current: string) =>
      `${label}: project level can only tighten the permission mode; ignoring ${value} (current ${current})`,
    projectLowerOnly: (label: string, key: string, value: number, current: number) =>
      `${label}: project level can only lower ${key}; ignoring ${value} (current ${current})`,
    projectNoAllow: (label: string, rules: string) =>
      `${label}: project level cannot add allow rules; ignoring ${rules}`,
    projectNoBuiltinDeny: (label: string) =>
      `${label}: project level cannot change the built-in deny table; ignoring permission.builtinDeny`,
    projectNoAutoSafe: (label: string) =>
      `${label}: project level cannot add permission.autoSafeCommands (loosening); ignored`,
    projectModeLoosen: (label: string, mode: string) =>
      `${label}: project level cannot set the permission mode to ${mode} (loosening; only the user config, profile or command line may); ignored`,
  },
  /** 读配置文件（load.ts）。 */
  load: {
    jsonSyntax: (line: number | string, column: number | string, message: string) =>
      `JSON syntax error (line ${line}, column ${column}): ${message}`,
    jsonSyntaxNear: (line: number, column: number, message: string) =>
      `JSON syntax error (near line ${line}, column ${column}): ${message}`,
    jsonEmpty: "JSON syntax error: the file is empty",
    notFound: "file not found",
    invalid: (lines: readonly string[]) => `invalid config file:\n  ${lines.join("\n  ")}`,
  },
  /** [W6-I5] profile.json（profile.ts）。 */
  profile: {
    notFound: (path: string) => `${path}: file not found`,
    relativePaths: (path: string, lines: readonly string[]) =>
      `${path}: paths in a profile must be absolute:\n  ${lines.join("\n  ")}`,
  },
  /** [W6-I5] auth.json 权限过宽（auth-file.ts）。 */
  authFile: {
    modeTooOpen: (path: string, mode: string) =>
      `${path}: permissions are ${mode}, should be 0600 (chmod 600 ${path})`,
  },
  /** 目录（paths.ts）。 */
  paths: {
    notDirectory: "not a directory",
    notWritable: (label: string, dir: string, reason: string) =>
      `${label} is not writable: ${dir} (${reason})`,
    configDir: "config directory",
    dataDir: "data directory",
    sessionDir: "session directory",
  },
  /** 上下文文件（context-files.ts）。 */
  context: {
    readFailed: (path: string, reason: string) => `${path}: failed to read (${reason})`,
    truncated: (path: string, maxBytes: number) =>
      `${path}: larger than ${maxBytes} bytes, truncated`,
  },
  /** `ama init`（init.ts）。 */
  init: {
    status: {
      created: "created",
      exists: "already exists, left unchanged",
      updated: "updated to the current version",
      unchanged: "already the current version",
      overwritten: "rewritten (original backed up as .bak)",
    },
    dirCreated: "created (0700)",
    dirExists: "already exists",
    nextSteps: [
      "Next steps:",
      "  ama auth set anthropic          save a key for a built-in provider (or set ANTHROPIC_API_KEY etc.)",
      "  ama providers add <id> --base-url <url>   connect a relay or self-hosted service",
      "  ama doctor                      check config, keys and environment",
      "  ama config show                 show the effective config and where each value comes from",
    ].join("\n"),
  },
  /** config.schema.json 里供应商内部字段的说明（顶层与各段的键用 `keys`）。 */
  jsonSchema: {
    api: "Protocol",
    compat: 'Protocol compatibility switches (docs/guides/providers.md "compat")',
    modelId: "Model id (the name sent upstream)",
    modelBaseUrl: "Overrides the channel / provider address",
    contextWindow:
      "Context tokens; filled from models.dev by default, not guessed when there is no match",
    maxTokens: "Output limit per request; defaults to min(models.dev, 64k) or 8192",
    input: '["text"] or ["text", "image"] (accepts images)',
    modelChannels: "Channels the model is mounted on; the first is preferred",
    modelsDev: 'models.dev entry "provider/model"; false disables enrichment',
    modelCatalog:
      'Built-in catalog entry "provider/model" whose intrinsic properties this model inherits; matched by id alias when unset; false disables',
    baseUrl: "Endpoint address",
    channelApiKey: "$ENV / ${ENV} / !command / literal; defaults to the provider's key",
    apiKey: "$ENV / ${ENV} / !command / literal",
    channels: "Channels: several endpoints under one provider",
    defaultChannel: "Preferred channel; defaults to the first of channels",
    models: "Custom models (an entry with the same id replaces the whole model)",
    modelOverrides: "Only changes metadata of existing models",
  },
  ...keyDocs.en,
};

export const zh = {
  schema: {
    enumArray: (choices) => `应为 ${choices.join(" | ")} 组成的数组`,
    ports: "应为端口号数组（0–65535；0 = 任意空闲端口）",
    required: "缺少必填字段",
    memoryDir: "memory.enabled 为 true 时 memory.dir 必须是绝对路径",
    object: "应为对象",
    unknownKey: "未知字段，已忽略",
    version: "version 必须为 1",
    requiredString: "缺少必填字符串",
    string: "应为字符串",
    boolean: "应为布尔值",
    number: "应为数字",
    range: (min, max) => `应在 ${min}–${max} 之间`,
    oneOf: (choices) => `取值应为 ${choices.join(" | ")}`,
    stringArray: "应为字符串数组",
    array: "应为数组",
    modelsDev: `应为 "provider/model" 或 false`,
    catalog: `应为 "provider/model" 或 false`,
    modelsEnabled: `应为 "provider/model[@channel]" 或 "provider/*"`,
    noChannels: "供应商没有 channels",
    unknownChannelOf: (name, available) => `渠道 "${name}" 不存在（可用：${available.join(", ")}）`,
    modelInput: `应为 ("text" | "image")[]`,
    channelName: "渠道名只能含字母、数字、_ 与 -（不含 / 与 @），最长 32",
    atLeastOneChannel: "至少要有一个渠道",
    unknownChannel: (name) => `渠道 "${name}" 不存在`,
    defaultChannelWithoutChannels: "没有 channels 时不能设 defaultChannel",
    builtinDeny: "应为布尔值或字符串数组",
    writablePath: "应为绝对路径或 ~/…，已忽略",
    providersMissing: "缺少 providers",
    hookEvent: (events) => `未知事件（可用：${events.join(", ")}）`,
    hookType: `type 必须为 "command"`,
    hookCommandEmpty: "命令为空",
    clearAtLeast: '应为 "auto" 或非负数字',
    agentId: "Agent id 只能是小写字母、数字、- . _（可带 acp: 前缀）",
  },
  merge: {
    projectIgnored: (label, key) => `${label}: 项目级不能设 ${key}，已忽略`,
    projectMemoryOnlyDisable: (label) =>
      `${label}: 项目级只能把 memory.enabled 设为 false，忽略 memory 的其它键`,
    projectOnlyKeys: (label, allowed, ignored) =>
      `${label}: 项目级只能设 ${allowed}，忽略 ${ignored}`,
    projectPresetLoosen: (label, preset, current) =>
      `${label}: 项目级不能放宽工具预设，忽略 tools.preset ${preset}（当前 ${current}）`,
    projectOnlyValue: (label, key, value, ignored) =>
      `${label}: 项目级只接受 ${key} "${value}"，忽略 ${ignored}`,
    projectPlanBashTighten: (label, value, current) =>
      `${label}: 项目级只能收紧 plan.bash，忽略 ${value}（当前 ${current}）`,
    projectModeTighten: (label, value, current) =>
      `${label}: 项目级只能收紧权限模式，忽略 ${value}（当前 ${current}）`,
    projectLowerOnly: (label, key, value, current) =>
      `${label}: 项目级只能调小 ${key}，忽略 ${value}（当前 ${current}）`,
    projectNoAllow: (label, rules) => `${label}: 项目级不能加 allow 规则，忽略 ${rules}`,
    projectNoBuiltinDeny: (label) =>
      `${label}: 项目级不能改内置 deny 表，忽略 permission.builtinDeny`,
    projectNoAutoSafe: (label) =>
      `${label}: 项目级不能追加 permission.autoSafeCommands（放宽），已忽略`,
    projectModeLoosen: (label, mode) =>
      `${label}: 项目级不能把权限模式设为 ${mode}（放宽，只能在用户级配置、profile 或命令行设），已忽略`,
  },
  load: {
    jsonSyntax: (line, column, message) =>
      `JSON 语法错误（第 ${line} 行第 ${column} 列）：${message}`,
    jsonSyntaxNear: (line, column, message) =>
      `JSON 语法错误（第 ${line} 行第 ${column} 列附近）：${message}`,
    jsonEmpty: "JSON 语法错误：文件为空",
    notFound: "文件不存在",
    invalid: (lines) => `配置文件无效：\n  ${lines.join("\n  ")}`,
  },
  profile: {
    notFound: (path) => `${path}: 文件不存在`,
    relativePaths: (path, lines) =>
      `${path}: profile 中的路径必须是绝对路径：\n  ${lines.join("\n  ")}`,
  },
  authFile: {
    modeTooOpen: (path, mode) => `${path}: 权限为 ${mode}，应为 0600（chmod 600 ${path}）`,
  },
  paths: {
    notDirectory: "不是目录",
    notWritable: (label, dir, reason) => `${label}不可写：${dir}（${reason}）`,
    configDir: "配置目录",
    dataDir: "数据目录",
    sessionDir: "会话目录",
  },
  context: {
    readFailed: (path, reason) => `${path}: 读取失败（${reason}）`,
    truncated: (path, maxBytes) => `${path}: 超过 ${maxBytes} 字节，已截断`,
  },
  init: {
    status: {
      created: "已创建",
      exists: "已存在，未改动",
      updated: "已更新为当前版本",
      unchanged: "已是当前版本",
      overwritten: "已重写（原文件备份为 .bak）",
    },
    dirCreated: "已创建（0700）",
    dirExists: "已存在",
    nextSteps: [
      "下一步：",
      "  ama auth set anthropic          保存内置供应商的 key（或设置 ANTHROPIC_API_KEY 等环境变量）",
      "  ama providers add <id> --base-url <url>   接入中转站或自建服务",
      "  ama doctor                      检查配置、key 与运行环境",
      "  ama config show                 查看生效配置与每项来源",
    ].join("\n"),
  },
  jsonSchema: {
    api: "协议",
    compat: "协议兼容开关（docs/guides/providers.md「compat」）",
    modelId: "模型 id（发给上游的名字）",
    modelBaseUrl: "覆盖渠道 / 供应商的地址",
    contextWindow: "上下文 token；缺省从 models.dev 补，匹配不到不猜",
    maxTokens: "单次输出上限；缺省 min(models.dev, 64k) 或 8192",
    input: '["text"] 或 ["text", "image"]（收图片）',
    modelChannels: "挂载的渠道，第一个是首选",
    modelsDev: 'models.dev 条目 "provider/model"；false 关闭补全',
    modelCatalog:
      '继承其固有属性的内置目录条目 "provider/model"；不写时按 id 别名自动匹配；false 关闭',
    baseUrl: "接口地址",
    channelApiKey: "$ENV / ${ENV} / !command / 字面量；缺省用供应商的 key",
    apiKey: "$ENV / ${ENV} / !command / 字面量",
    channels: "渠道：一个供应商下的多种接口",
    defaultChannel: "首选渠道；缺省 channels 的第一个",
    models: "自定义模型（同 id 整条替换）",
    modelOverrides: "只改已有模型的元数据",
  },
  ...keyDocs.zh,
} satisfies Messages<typeof en>;
