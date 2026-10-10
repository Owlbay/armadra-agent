/**
 * 消息目录：drivers（键名规范见 docs/guides/i18n.md）。[W6-C0 建空壳，W6-I3 迁入 `src/{drivers,agents,hooks,host}/**`]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * 这里只放给人看的提示（外部 Agent 的 notice、日志、Hook 警告、宿主适配器错误）；进 task 工具结果、
 * 回给模型的文本固定英文，写在各模块里、不走这里。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  /** 外部 Agent 的 notice 与日志。 */
  agent: {
    reapedOrphans: (pids: string) =>
      `cleaned up external agent processes left over from last time: ${pids}`,
    unverifiedVersion: (program: string, version: string, verified: string) =>
      `${program} ${version} is outside the verified range ${verified}; the protocol may have changed`,
    cancelGraceExpired:
      "the external agent did not end its turn within the grace period after interrupt; closing the process",
    modeClamped: (agent: string, chosen: string, requested: string) =>
      `${agent} runs in "${chosen}" mode (requested "${requested}"; an external agent may not be looser than ama's current mode)`,
    overBudget: (agent: string) => `${agent} exceeded its USD budget; interrupted`,
    timedOut: (agent: string) => `${agent} timed out; interrupted`,
    resumeUnsupported: (agent: string) => `${agent} cannot resume sessions; started a new one`,
    resumeNotFound: (agent: string, id: string) =>
      `${agent} cannot find session ${id}; started a new one`,
    noMatchingMode: (agent: string, mode: string) =>
      `${agent} has no "${mode}" mode; running in its own default mode (actions that need approval still come to you)`,
    noMatchingModel: (agent: string, model: string) =>
      `${agent} does not offer model "${model}"; using its own default model`,
    noImages: (agent: string) => `${agent} does not accept images; omitted`,
    noImagesDriver: (agent: string) => `the ${agent} driver does not pass images yet; omitted`,
    noImagesOneshot: (agent: string) => `${agent} one-shot mode does not pass images; omitted`,
    initializeRejected: (agent: string, error: string) =>
      `${agent}: initialize was not accepted (${error})`,
    nonJson: (agent: string) => `${agent}: non-JSON output`,
    denials: (agent: string, count: number) =>
      `${agent} had ${plural(count, "action")} denied because no one was there to approve`,
    budgetStop: (agent: string) => `${agent} reached its USD budget limit; stopped`,
    error: (agent: string, message: string, retrying: boolean) =>
      `${agent}: ${message}${retrying ? " (retrying)" : ""}`,
    askedQuestion: (agent: string, tool: string) =>
      `${agent} wants to ask you a question (${tool}); ama does not answer for you and asked it to put the question in its final reply`,
    askedQuestionCodex: (agent: string) =>
      `${agent} wants to ask you a question; ama does not answer for you — have it put the question in its final reply`,
    extensionDialog: (agent: string, title: string) =>
      `${agent}: an extension asked for input (${title}); ama does not answer for you, cancelled`,
    mcpElicitation: (agent: string) =>
      `${agent}'s MCP server asked for input; ama does not answer for you, cancelled`,
  },
  /** Hook 配置与输出的警告（给人看；回给模型的阻止理由固定英文）。 */
  hooks: {
    configInvalid: (lines: string) => `invalid config file:\n  ${lines}`,
    projectUntrusted: (path: string) =>
      `${path}: project not trusted, skipping project hooks (use --trust or confirm trust in interactive mode)`,
    unknownDecision: (value: string) => `unknown decision: ${value}`,
    notString: (key: string) => `${key} must be a string`,
    timedOut: (event: string, command: string, ms: number) =>
      `Hook ${event} "${command}" timed out (${ms} ms)`,
    failed: (event: string, command: string, exitCode: number | null, tail: string) =>
      `Hook ${event} "${command}" failed (${exitCode === null ? "killed by a signal" : `exit code ${exitCode}`})${tail === "" ? "" : `: ${tail}`}`,
    invalidDecision: (event: string, command: string, decision: string) =>
      `Hook ${event} "${command}": decision "${decision}" is not valid for ${event}; ignored`,
    multipleInputs: (count: number) => `${count} hooks returned updatedInput at once; all ignored`,
    multiplePrompts: (count: number) =>
      `${count} hooks returned updatedPrompt at once; all ignored`,
  },
  /** 宿主适配器（host/**）：错误给宿主开发者看，宿主按 code 判断。 */
  host: {
    handlerFailed: (name: string) => `host event handler threw (${name})`,
    toolNotObject: "tools.register: the tool definition must be an object",
    toolBadName: (name: string) => `tools.register: invalid tool name: ${name}`,
    toolNoExecute: (name: string) => `tools.register: ${name} is missing execute()`,
    toolBadPermission: (name: string) => `tools.register: ${name} has an invalid permission`,
    toolExists: (name: string) => `tools.register: tool ${name} already exists`,
    instructionNeedsPath: "instructions.add: file needs path",
    instructionNeedsText: "instructions.add: text needs text",
    brokerNeedsAsk: "approvals.setBroker: broker needs ask()",
    warmingNeedsFunction: "cache.onWarmingDecision: needs a function",
    runnerNeedsIdStart: "runners.provide: needs a runner with id and start",
    notAdapter: (label: string) =>
      `${label}: not a host adapter module (missing hostApi / create export)`,
    versionMismatch: (label: string, found: string, needed: number) =>
      `${label}: host adapter hostApi=${found}, ama needs ${needed}`,
    noCreate: (label: string) => `${label}: missing create(api) function`,
    notFound: (path: string) => `host adapter not found: ${path}`,
    loadFailed: (path: string, error: string) => `failed to load host adapter: ${path}: ${error}`,
    createTimeout: (label: string, ms: number) =>
      `${label}: create() did not return within ${ms} ms`,
    createFailed: (label: string, error: string) => `${label}: create() failed: ${error}`,
    noId: (label: string) => `${label}: the adapter returned by create() has no id`,
  },
};

export const zh = {
  agent: {
    reapedOrphans: (pids) => `清理了上次遗留的外部 Agent 进程：${pids}`,
    unverifiedVersion: (program, version, verified) =>
      `${program} ${version} 不在已验证区间 ${verified}，协议可能有变化`,
    cancelGraceExpired: "外部 Agent 中断后未在宽限内结束回合，关闭进程",
    modeClamped: (agent, chosen, requested) =>
      `${agent} 以「${chosen}」模式运行（请求的是「${requested}」，外部 Agent 不得比 ama 当前模式宽）`,
    overBudget: (agent) => `${agent} 超出美元预算，已中断`,
    timedOut: (agent) => `${agent} 运行超时，已中断`,
    resumeUnsupported: (agent) => `${agent} 不支持续接会话，已新开`,
    resumeNotFound: (agent, id) => `${agent} 找不到会话 ${id}，已新开`,
    noMatchingMode: (agent, mode) =>
      `${agent} 没有「${mode}」模式，按它自己的缺省模式运行（需要授权的操作仍交给你）`,
    noMatchingModel: (agent, model) => `${agent} 没有模型「${model}」，按它自己的缺省模型运行`,
    noImages: (agent) => `${agent} 不接受图片，已省略`,
    noImagesDriver: (agent) => `${agent} 驱动暂不传图片，已省略`,
    noImagesOneshot: (agent) => `${agent} 一次性模式不传图片，已省略`,
    initializeRejected: (agent, error) => `${agent}: initialize 未被接受（${error}）`,
    nonJson: (agent) => `${agent}: 非 JSON 输出`,
    denials: (agent, count) => `${agent} 有 ${count} 次操作因无人审批被拒绝`,
    budgetStop: (agent) => `${agent} 达到美元预算上限，已停止`,
    error: (agent, message, retrying) => `${agent}：${message}${retrying ? "（重试中）" : ""}`,
    askedQuestion: (agent, tool) =>
      `${agent} 想向你提问（${tool}）；ama 不代答，已请它把问题写进最终回复`,
    askedQuestionCodex: (agent) => `${agent} 想向你提问；ama 不代答，请让它把问题写进最终回复`,
    extensionDialog: (agent, title) => `${agent}：扩展请求输入（${title}）；ama 不代答，已取消`,
    mcpElicitation: (agent) => `${agent} 的 MCP 服务器请求输入；ama 不代答，已取消`,
  },
  hooks: {
    configInvalid: (lines) => `配置文件无效：\n  ${lines}`,
    projectUntrusted: (path) =>
      `${path}: 项目未信任，跳过项目级 Hook（用 --trust 或在交互模式确认信任）`,
    unknownDecision: (value) => `未知 decision：${value}`,
    notString: (key) => `${key} 应为字符串`,
    timedOut: (event, command, ms) => `Hook ${event}「${command}」超时（${ms} ms）`,
    failed: (event, command, exitCode, tail) =>
      `Hook ${event}「${command}」失败（${exitCode === null ? "被信号终止" : `退出码 ${exitCode}`}）${tail === "" ? "" : `：${tail}`}`,
    invalidDecision: (event, command, decision) =>
      `Hook ${event}「${command}」的 decision "${decision}" 对 ${event} 无效，已忽略`,
    multipleInputs: (count) => `${count} 个 Hook 同时返回 updatedInput，全部忽略`,
    multiplePrompts: (count) => `${count} 个 Hook 同时返回 updatedPrompt，全部忽略`,
  },
  host: {
    handlerFailed: (name) => `宿主事件处理器异常（${name}）`,
    toolNotObject: "tools.register：工具定义应为对象",
    toolBadName: (name) => `tools.register：工具名不合法：${name}`,
    toolNoExecute: (name) => `tools.register：${name} 缺少 execute()`,
    toolBadPermission: (name) => `tools.register：${name} 的 permission 不合法`,
    toolExists: (name) => `tools.register：工具 ${name} 已存在`,
    instructionNeedsPath: "instructions.add：file 需要 path",
    instructionNeedsText: "instructions.add：text 需要 text",
    brokerNeedsAsk: "approvals.setBroker：broker 需要 ask()",
    warmingNeedsFunction: "cache.onWarmingDecision：需要函数",
    runnerNeedsIdStart: "runners.provide：需要带 id 与 start 的 runner",
    notAdapter: (label) => `${label}: 不是宿主适配器模块（缺少 hostApi / create 导出）`,
    versionMismatch: (label, found, needed) =>
      `${label}: 宿主适配器 hostApi=${found}，ama 需要 ${needed}`,
    noCreate: (label) => `${label}: 缺少 create(api) 函数`,
    notFound: (path) => `宿主适配器不存在：${path}`,
    loadFailed: (path, error) => `宿主适配器加载失败：${path}：${error}`,
    createTimeout: (label, ms) => `${label}: create() 超过 ${ms} ms 未返回`,
    createFailed: (label, error) => `${label}: create() 失败：${error}`,
    noId: (label) => `${label}: create() 返回的适配器缺少 id`,
  },
} satisfies Messages<typeof en>;
