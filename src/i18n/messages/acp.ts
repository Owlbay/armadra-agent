/**
 * 消息目录：acp（键名规范见 docs/i18n.md）。[ACP-C0 从 print.acp 迁入，docs/acp-plan.md D15]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * 发给 ACP 客户端的 name / description / error message 是给人看的，走这里；`_meta`、id、value 等机器字段不翻译。
 * 子对象各归一个批次：core（现有服务端文案）、auth（A）、session（B）、tools（C）、config / client（D）。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  /** ACP 服务端（`ama --mode acp`）的现有文案。 */
  core: {
    missingParam: (key: string) => `missing ${key}`,
    promptNotArray: "prompt must be an array of content blocks",
    unparsable: (reason: string) => `ACP: unparsable input (${reason})`,
    missingProtocolVersion: "missing protocolVersion",
    fixedCwd: (cwd: string, got: string) =>
      `the session directory of ama --mode acp is fixed to the start directory ${cwd} (got ${got})`,
    sessionNotFound: (id: string, error: string) => `session ${id} not found: ${error}`,
    modelFailed: "model request failed",
    unknownMode: (mode: string) => `unknown mode: ${mode}`,
    allowOnce: "Allow",
    allowAlways: "Allow for this session",
    rejectOnce: "Deny",
    unknownConfigOption: (id: string) => `unknown config option: ${id}`,
  },
  /** [ACP-A] 认证门与终端认证方法。 */
  auth: {
    chatgptName: "Sign in with ChatGPT",
    chatgptDescription: "Runs ama auth login chatgpt in a terminal (ChatGPT subscription)",
    apiKeyName: "Enter an API key",
    apiKeyDescription: "Runs ama auth set in a terminal: pick a provider, then paste its API key",
    notAgentMethod:
      "ama only offers terminal auth methods, which are not passed to authenticate; run the method in a terminal",
    waiting: (reason: string) =>
      `no model available yet (${reason}); ACP stays up — sign in from the client's terminal login or run ama auth set, then open a session again`,
    ready: (model: string) => `model available (${model}); ACP sessions are served from now on`,
  },
  /** [ACP-B] 多会话与会话元数据。 */
  session: {
    notOpen: (id: string) =>
      `session ${id} is not open in this connection; send session/load or session/resume first`,
    invalidCursor: "invalid cursor (pass back the nextCursor of a previous session/list)",
    ignoredMcp: (count: number) =>
      `ACP: ignoring ${plural(count, "MCP server")} from the client (ama does not connect MCP servers)`,
    ignoredDirs: (count: number) =>
      `ACP: ignoring ${plural(count, "additional directory", "additional directories")} from the client (the workspace is fixed to the start directory)`,
  },
  /** [ACP-C] 工具调用映射。 */
  tools: {
    /** codemode 脚本里的内层调用的标题。 */
    codemodePrefix: (title: string) => `codemode › ${title}`,
    truncated: (length: number) => `…(truncated, ${plural(length, "character")} in total)`,
  },
  /** [ACP-D] 配置项与命令表。 */
  config: {
    model: "Model",
    mode: "Permission mode",
    thinking: "Thinking level",
    levels: {
      off: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
    },
    invalidValue: (id: string, value: string) => `invalid value for config option ${id}: ${value}`,
    unknownModel: (ref: string) => `unknown model: ${ref}`,
  },
  /** [ACP-D] ama 作 ACP 客户端时的文案。 */
  client: {
    authRequired: (agent: string, methods: readonly string[]) =>
      `${agent} requires sign-in. Sign in with one of: ${methods.join("; ")}; then try again`,
    authNoMethods: (agent: string) =>
      `${agent} requires sign-in and offers no sign-in method; sign in with the agent's own CLI, then try again`,
    authTerminal: (name: string, command: string) => `${name} (run in a terminal: ${command})`,
  },
};

export const zh = {
  core: {
    missingParam: (key) => `缺少 ${key}`,
    promptNotArray: "prompt 应为内容块数组",
    unparsable: (reason) => `ACP：无法解析的输入（${reason}）`,
    missingProtocolVersion: "缺少 protocolVersion",
    fixedCwd: (cwd, got) => `ama --mode acp 的会话目录固定为启动目录 ${cwd}（收到 ${got}）`,
    sessionNotFound: (id, error) => `找不到会话 ${id}：${error}`,
    modelFailed: "模型请求失败",
    unknownMode: (mode) => `未知模式：${mode}`,
    allowOnce: "允许",
    allowAlways: "本会话允许",
    rejectOnce: "拒绝",
    unknownConfigOption: (id) => `未知配置项：${id}`,
  },
  auth: {
    chatgptName: "使用 ChatGPT 登录",
    chatgptDescription: "在终端运行 ama auth login chatgpt（ChatGPT 订阅）",
    apiKeyName: "填写 API key",
    apiKeyDescription: "在终端运行 ama auth set：选供应商后粘贴它的 API key",
    notAgentMethod: "ama 只提供终端型认证方法，这类方法不经 authenticate；请在终端里运行该方法",
    waiting: (reason) =>
      `暂无可用模型（${reason}）；ACP 连接保持——在客户端的终端登录或运行 ama auth set 后再开会话`,
    ready: (model) => `模型已可用（${model}），开始处理 ACP 会话`,
  },
  session: {
    notOpen: (id) => `会话 ${id} 没有在本连接中打开；先发 session/load 或 session/resume`,
    invalidCursor: "无效的 cursor（应原样传回上一次 session/list 的 nextCursor）",
    ignoredMcp: (count) => `ACP：忽略客户端给的 ${count} 个 MCP 服务器（ama 不连接 MCP）`,
    ignoredDirs: (count) => `ACP：忽略客户端给的 ${count} 个附加目录（工作目录固定为启动目录）`,
  },
  tools: {
    codemodePrefix: (title) => `codemode › ${title}`,
    truncated: (length) => `…（已截断，共 ${length} 字符）`,
  },
  config: {
    model: "模型",
    mode: "权限模式",
    thinking: "思考级别",
    levels: {
      off: "关",
      minimal: "最低",
      low: "低",
      medium: "中",
      high: "高",
      xhigh: "超高",
    },
    invalidValue: (id, value) => `配置项 ${id} 的值无效：${value}`,
    unknownModel: (ref) => `未知模型：${ref}`,
  },
  client: {
    authRequired: (agent, methods) =>
      `${agent} 需要先登录。可用的登录方式：${methods.join("；")}；登录后再试`,
    authNoMethods: (agent) =>
      `${agent} 需要先登录，但没有提供登录方式；请用它自己的命令行登录后再试`,
    authTerminal: (name, command) => `${name}（在终端里运行：${command}）`,
  },
} satisfies Messages<typeof en>;
