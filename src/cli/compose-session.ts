/**
 * 组装根：`SessionAssembly` → `AgentSessionImpl`（实施计划 §1.2、§1.4）。[B6]
 *
 * - 审批：一个 `ApprovalBrokerChain`（串行队列）作 B2 `brokers` 的唯一元素；链首代理宿主 broker
 *   （`assembly.host.broker()` 每次现取，宿主可在任意时刻 `setBroker`），链尾代理模式层经
 *   `Runtime.approvals.setUiBroker` 晚绑定的 UI broker。子 Agent 的请求由 B2 包上 `context.depth`
 *   后进同一条链，排在父对话框之后。
 * - 系统提示：AGENTS.md + `--instructions` 文件（project_context 节）、Skill 索引（read 读取）、
 *   宿主 instructions（host 节，读成文本）。SessionStart Hook 的 additionalContext 与宿主后加的
 *   指令在每次提示展开前 `updateSystem`——值不变时不产生补丁，前缀保持逐字节稳定（§9.1）。
 * - 事件：`SessionEvent` 桥接到宿主 `AgentEventBus`（§1.4 表；hook_executed、session_start /
 *   session_shutdown 由 bootstrap 发，不桥接）；第三波加 `cache_miss` / `context_pressure`。
 * - 缓存（第三波 §1.12）：config `cache` 段（项目级已在合并时忽略）+ `AMA_CACHE_WARMING` /
 *   `AMA_CACHE_RETENTION` 覆盖 → 会话的 `cache` 设置；宿主 `cache.onWarmingDecision` 每次现取。
 * - 会话切换：`switchSession()` 复用同一份装配材料建新会话，`assembly.onSessionReplaced(next)`
 *   让宿主访问、Hook 公共字段与退出 dispose 跟随新会话。
 */

import type { ProviderRegistryApi } from "../ai/types.js";
import { readFileSync } from "node:fs";
import { AgentSessionImpl, type AgentSessionOptions } from "../agent/session.js";
import type { AgentSession, CacheSettings, SessionEvent } from "../agent/types.js";
import { WARMING_MODES, type WarmingMode } from "../ai/cache/types.js";
import { isOverflowErrorText } from "../ai/overflow.js";
import type { Model, ModelThinkingLevel } from "../ai/types.js";
import { CACHE_RETENTIONS, type AmaConfig } from "../config/types.js";
import { AmaError, StartupError } from "../errors.js";
import type { AgentEventBus } from "../host/api-impl.js";
import type { InstructionSource } from "../host/types.js";
import { ApprovalBrokerChain, DEFAULT_APPROVAL_TIMEOUT_MS } from "../permissions/broker.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import { SessionManager } from "../session/manager.js";
import { sessionDirForCwd } from "../session/store.js";
import type { Skill } from "../skills/discover.js";
import { expandSkillCommand } from "../skills/expand.js";
import { formatSkillIndex } from "../skills/index-prompt.js";
import { expandPromptCommand, type PromptTemplate } from "../skills/templates.js";
import { PresetToolRegistry } from "../tools/presets.js";
import type { ToolDefinition } from "../tools/types.js";
import { openSession } from "./compose-store.js";
import type { SessionAssembly } from "./deps.js";
import { ExitCode } from "./exit-codes.js";
import type { Runtime } from "./runtime.js";

/** createRuntimeDeps 闭包里跨步骤共享的状态。 */
export interface ComposeState {
  /** 第 10 步发现的完整 Skill（`/skill:` 展开与索引用）。 */
  skills: Skill[];
  templates: PromptTemplate[];
  /** 没有 warn 通道的步骤（tools.create 等）留下的 warning，组装会话时交给 assembly.warn。 */
  warnings: string[];
  /** 当前会话（工具工厂的 `session()`）。 */
  session: AgentSession | undefined;
  /** 第 11 步建好的供应商注册表（read 工具判断当前模型收不收图片）。 */
  providers?: ProviderRegistryApi;
}

export function emptyComposeState(): ComposeState {
  return { skills: [], templates: [], warnings: [], session: undefined };
}

export type LogFn = (level: "debug" | "info" | "warn" | "error", message: string) => void;

export interface SessionComposeOptions {
  /** 审批超时（缺省 10 分钟）；`AMA_APPROVAL_TIMEOUT_MS` 覆盖。 */
  approvalTimeoutMs?: number | undefined;
  log?: LogFn | undefined;
}

interface SessionRecord {
  assembly: SessionAssembly;
  state: ComposeState;
  options: SessionComposeOptions;
  chain: ApprovalBrokerChain;
  current: AgentSessionImpl;
  /** SessionStart Hook 的 additionalContext（初始会话现取 assembly 的）。 */
  hookContext: () => string | undefined;
  hostTexts: Map<string, string>;
  log: LogFn;
}

const records = new WeakMap<AgentSession, SessionRecord>();

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** `AMA_LOG=debug|info|warn|error`（缺省 warn）过滤后写 stderr。 */
export function stderrLog(env: NodeJS.ProcessEnv = process.env): LogFn {
  const wanted = LOG_LEVELS.indexOf((env["AMA_LOG"] ?? "warn") as (typeof LOG_LEVELS)[number]);
  const min = wanted < 0 ? 2 : wanted;
  return (level, message) => {
    if (LOG_LEVELS.indexOf(level) >= min) process.stderr.write(`ama: [${level}] ${message}\n`);
  };
}

function approvalTimeout(options: SessionComposeOptions): number {
  const fromEnv = Number(process.env["AMA_APPROVAL_TIMEOUT_MS"]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
}

function sourceText(source: InstructionSource, cache: Map<string, string>, log: LogFn): string {
  if (source.kind === "text") return source.text;
  const cached = cache.get(source.path);
  if (cached !== undefined) return cached;
  let text = "";
  try {
    text = readFileSync(source.path, "utf8");
  } catch (error) {
    log("warn", `读取指令文件失败：${source.path}：${(error as Error).message}`);
  }
  cache.set(source.path, text);
  return text;
}

function hostInstructions(record: SessionRecord): string[] {
  return record.assembly.host.instructions
    .map((s) => sourceText(s, record.hostTexts, record.log))
    .filter((t) => t.trim() !== "");
}

/** `--instructions` 文件追加在 AGENTS.md 之后（project_context 节，实施计划表 B17）。 */
function contextFiles(record: SessionRecord): { path: string; content: string }[] {
  const { resources } = record.assembly;
  const extra = resources.instructions.map((s) => ({
    path: s.kind === "file" ? s.path : (s.name ?? "instructions"),
    content: sourceText(s, record.hostTexts, record.log),
  }));
  return [...resources.contextFiles, ...extra.filter((f) => f.content.trim() !== "")];
}

function systemInput(
  record: SessionRecord,
  active: readonly string[],
): NonNullable<AgentSessionOptions["system"]> {
  const system: NonNullable<AgentSessionOptions["system"]> = { contextFiles: contextFiles(record) };
  const index = formatSkillIndex(record.state.skills, {
    hasSkillTool: false,
    hasReadTool: active.includes("read"),
  });
  if (index !== "") system.skillsIndex = index;
  const host = hostInstructions(record);
  if (host.length > 0) system.hostInstructions = host;
  const hookContext = record.hookContext();
  if (hookContext !== undefined && hookContext !== "") system.hookContext = hookContext;
  return system;
}

/** 提示展开前刷新会晚到的系统提示材料（值不变则不产生补丁）。 */
function refreshSystem(record: SessionRecord, session: AgentSessionImpl): void {
  const patch: Parameters<AgentSessionImpl["updateSystem"]>[0] = {};
  const hookContext = record.hookContext();
  if (hookContext !== undefined && hookContext !== "") patch.hookContext = hookContext;
  const host = hostInstructions(record);
  if (host.length > 0) patch.hostInstructions = host;
  if (Object.keys(patch).length > 0) session.updateSystem(patch);
}

async function expandPrompt(
  record: SessionRecord,
  session: AgentSessionImpl,
  text: string,
): Promise<{ text: string }> {
  refreshSystem(record, session);
  const skill = await expandSkillCommand(text, record.state.skills);
  if (skill?.kind === "unknown") {
    const hint = skill.available.length > 0 ? `（可用：${skill.available.join(", ")}）` : "";
    throw new AmaError("skill_not_found", `未知 Skill：${skill.name}${hint}`);
  }
  if (skill?.kind === "expanded") return { text: skill.text };
  const template = await expandPromptCommand(text, record.state.templates);
  return { text: template?.text ?? text };
}

/** config `cache` 段 + 环境变量 → 会话缓存设置；非法的环境变量值忽略并 warning。 */
export function cacheSettingsFrom(
  config: Pick<AmaConfig, "cache">,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = () => undefined,
): Partial<CacheSettings> {
  const settings: Partial<CacheSettings> = {};
  for (const [key, value] of Object.entries(config.cache ?? {})) {
    if (value !== undefined) (settings as Record<string, unknown>)[key] = value;
  }
  const warming = env["AMA_CACHE_WARMING"];
  if (warming !== undefined && warming !== "") {
    if (WARMING_MODES.includes(warming as WarmingMode)) settings.warming = warming as WarmingMode;
    else warn(`AMA_CACHE_WARMING=${warming} 无效（off | streaming | idle），已忽略`);
  }
  const retention = env["AMA_CACHE_RETENTION"];
  if (retention !== undefined && retention !== "") {
    const value = retention as CacheSettings["retention"];
    if (CACHE_RETENTIONS.includes(value)) settings.retention = value;
    else warn(`AMA_CACHE_RETENTION=${retention} 无效（none | short | long），已忽略`);
  }
  return settings;
}

/**
 * 模型请求的空闲超时：`AMA_IDLE_TIMEOUT_MS` > config `request.idleTimeoutMs`；都没有 → undefined
 * （协议层取缺省 300 000）。0 关闭；非法的环境变量值忽略并 warning。
 */
export function idleTimeoutFrom(
  config: Pick<AmaConfig, "request">,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = () => undefined,
): number | undefined {
  const raw = env["AMA_IDLE_TIMEOUT_MS"];
  if (raw !== undefined && raw.trim() !== "") {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
    warn(`AMA_IDLE_TIMEOUT_MS=${raw} 无效（应为不小于 0 的毫秒数），已忽略`);
  }
  return config.request?.idleTimeoutMs;
}

/** §1.4：SessionEvent → AgentEvents。 */
export function bridgeEvent(event: SessionEvent, bus: AgentEventBus): void {
  switch (event.type) {
    case "before_agent_start":
      void bus.emit("before_agent_start", { prompt: event.prompt });
      return;
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "agent_before_settle":
      void bus.emit(event.type, {});
      return;
    case "agent_end":
      void bus.emit("agent_end", { stopReason: event.stopReason, willRetry: event.willRetry });
      return;
    case "agent_settled":
      void bus.emit("agent_settled", event.warning === undefined ? {} : { warning: event.warning });
      return;
    case "tool_execution_start":
      void bus.emit("tool_call", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
      });
      return;
    case "tool_execution_end":
      void bus.emit("tool_result", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      });
      return;
    case "permission_request":
      void bus.emit("tool_approval_requested", {
        requestId: event.requestId,
        toolName: event.toolName,
      });
      return;
    case "permission_resolved":
      void bus.emit("tool_approval_resolved", {
        requestId: event.requestId,
        decision: event.decision,
      });
      return;
    case "compaction_end":
      if (event.result !== undefined)
        void bus.emit("session_compact", { tokensBefore: event.result.tokensBefore });
      return;
    case "model_changed":
      void bus.emit("model_select", { model: event.model });
      return;
    case "cache_miss": {
      const { type: _type, ...miss } = event;
      void bus.emit("cache_miss", miss);
      return;
    }
    case "context_pressure": {
      const { type: _type, ...pressure } = event;
      void bus.emit("context_pressure", pressure);
      return;
    }
    default:
      return;
  }
}

function buildSession(
  record: SessionRecord,
  manager: SessionManager,
  model: Model,
  thinkingLevel: ModelThinkingLevel,
): AgentSessionImpl {
  const { assembly } = record;
  const registry = assembly.tools;
  const all = registry
    .list()
    .map((name) => registry.get(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined);
  const active = registry.active().map((tool) => tool.name);
  const config = assembly.config;
  let session: AgentSessionImpl | undefined;
  const options: AgentSessionOptions = {
    sessionManager: manager,
    providers: assembly.providers,
    model,
    thinkingLevel,
    tools: all,
    activeTools: active,
    permission: assembly.permission,
    brokers: [record.chain],
    unattended: assembly.unattended,
    approvalTimeoutMs: approvalTimeout(record.options),
    hooks: assembly.hooks,
    system: systemInput(record, active),
    compaction: { ...config.compaction },
    retry: { ...config.retry },
    expandPrompt: (text) => expandPrompt(record, session as AgentSessionImpl, text),
    isContextOverflow: isOverflowErrorText,
    subagents: registry.get("task") === undefined ? false : { maxConcurrent: 4 },
    log: record.log,
    cache: cacheSettingsFrom(config, process.env, (message) => record.log("warn", message)),
    warmingDecider: () => assembly.host.warmingDecider?.(),
  };
  const maxTurns = assembly.overrides?.maxTurns;
  if (maxTurns !== undefined) options.maxTurns = maxTurns;
  const idle = idleTimeoutFrom(config, process.env, (message) => record.log("warn", message));
  if (idle !== undefined) options.idleTimeoutMs = idle;
  const autoModel = config.permission?.autoModel;
  if (autoModel !== undefined) options.permissionClassifier = { model: autoModel };
  const maxChars = config.tools?.maxToolResultChars;
  if (maxChars !== undefined) options.maxToolResultChars = maxChars;
  const hostId = assembly.host.handle?.adapter.id;
  if (hostId !== undefined) options.hostId = hostId;
  session = new AgentSessionImpl(options);
  session.subscribe((event) => bridgeEvent(event, assembly.events));
  records.set(session, record);
  record.state.session = session;
  return session;
}

/** 第 14 步：组装主会话。 */
export function composeSession(
  assembly: SessionAssembly,
  state: ComposeState = emptyComposeState(),
  options: SessionComposeOptions = {},
): AgentSessionImpl {
  const manager = assembly.sessionManager;
  if (!(manager instanceof SessionManager)) {
    throw new AmaError(
      "invalid_arguments",
      "组装根只接受 SessionManager 实例（由 sessions.open 创建）",
    );
  }
  const { model } = assembly;
  if (assembly.providers.getApi(model.api) === undefined) {
    const via = model.api === "google-generative-ai" ? "；过渡期请经 openrouter 调用" : "";
    throw new StartupError(
      "provider_not_found",
      `模型 ${model.provider}/${model.id} 的协议 ${model.api} 尚未实现${via}`,
      ExitCode.NoModel,
    );
  }
  for (const warning of state.warnings.splice(0)) assembly.warn(warning);
  const timeoutMs = approvalTimeout(options);
  const chain = new ApprovalBrokerChain({ timeoutMs });
  chain.setHostBroker({
    ask: (request, signal) =>
      assembly.host.broker()?.ask(request, signal) ?? Promise.resolve(undefined),
  });
  chain.setUiBroker({
    ask: (request, signal) =>
      assembly.uiBroker()?.ask(request, signal) ?? Promise.resolve(undefined),
  });
  const record = {
    assembly,
    state,
    options,
    chain,
    hookContext: () => assembly.sessionStartContext(),
    hostTexts: new Map<string, string>(),
    log: options.log ?? stderrLog(),
  } as SessionRecord;
  const session = buildSession(record, manager, model, assembly.thinkingLevel);
  record.current = session;
  const registry = assembly.tools;
  if (registry instanceof PresetToolRegistry) {
    // 宿主在会话创建之后注册的工具：追加进当前会话，下次请求以 system 补丁声明（只在末尾追加）。
    registry.onRegister((tool) => {
      const active = registry.active().some((t) => t.name === tool.name);
      try {
        record.current.addTool(tool, active);
      } catch (error) {
        record.log("warn", `追加工具 ${tool.name} 失败：${(error as Error).message}`);
      }
    });
  }
  return session;
}

function recordOf(target: Runtime | AgentSession): SessionRecord | undefined {
  const key = "sessionManager" in target && "paths" in target ? target.session : target;
  return records.get(key as AgentSession);
}

/** 模式层当前应操作的会话（`switchSession` 之后不再是 `Runtime.session`）。 */
export function currentSession(target: Runtime | AgentSession): AgentSession {
  const record = recordOf(target);
  if (record !== undefined) return record.current;
  return "paths" in target && "sessionManager" in target ? target.session : target;
}

export type SwitchRequest =
  | { kind: "new" }
  | { kind: "open"; file: string }
  | { kind: "resume"; id: string }
  | { kind: "fork"; entryId: string };

/**
 * `/new`、`/resume`、`/fork`、RPC `new_session / switch_session / fork`：旧会话发 SessionEnd 后
 * dispose，新会话复用装配材料，宿主总线发 session_start，再跑 SessionStart Hook。
 */
export async function switchSession(
  target: Runtime | AgentSession,
  request: SwitchRequest,
): Promise<AgentSessionImpl> {
  const record = recordOf(target);
  if (record === undefined)
    throw new AmaError("not_implemented", "该会话不是由组装根创建的，不能切换");
  const old = record.current;
  if (old.state.isStreaming) throw new AmaError("busy", "运行中不能切换会话");
  const { assembly } = record;
  const sessionDir = assembly.paths.sessionDir;
  let manager: SessionManager;
  let source: "new" | "resume" | "fork";
  switch (request.kind) {
    case "new":
      manager = SessionManager.create(sessionDirForCwd(sessionDir, old.cwd), old.cwd);
      source = "new";
      break;
    case "open":
      manager = SessionManager.open(request.file);
      source = "resume";
      break;
    case "resume":
      manager = openSession({ kind: "resume", id: request.id }, { sessionDir, cwd: old.cwd });
      source = "resume";
      break;
    case "fork":
      manager = old.manager.fork(request.entryId);
      source = "fork";
      break;
  }
  await assembly.hooks
    .run("SessionEnd", { reason: request.kind === "new" ? "new" : "switch" })
    .catch(() => undefined);
  await old.dispose();
  if (assembly.permission instanceof PermissionPipeline) assembly.permission.clearSessionGrants();
  let hookContext: string | undefined;
  record.hookContext = () => hookContext;
  const next = buildSession(record, manager, old.model(), old.thinkingLevel());
  record.current = next;
  assembly.onSessionReplaced(next);
  const file = next.state.sessionFile;
  await assembly.events.emit("session_start", {
    sessionId: next.state.sessionId,
    ...(file !== undefined ? { sessionFile: file } : {}),
    cwd: next.cwd,
    reason: source,
  });
  const outcome = await assembly.hooks.run("SessionStart", { source }).catch(() => undefined);
  hookContext = outcome?.additionalContext;
  // 会话自身的 session_start 由模式在重新订阅之后调 `announceStart` 发（否则订阅者收不到）。
  return next;
}
