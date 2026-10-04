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
 * - [ACP-C0] 多会话：`createSessionAlongside()` 建兄弟会话（不替换前台、不 dispose 旧会话），
 *   `setForegroundSession()` 把宿主 / Hook / 工具工厂的「当前会话」切过去，`disposeSessionAlongside()`
 *   释放一个兄弟会话。事件桥接在 compose-events.ts。
 */

import type { ProviderRegistryApi } from "../ai/types.js";
import type { BashSandbox } from "../sandbox/bash.js";
import { readFileSync } from "node:fs";
import { resolveLimits } from "../agent/limits.js";
import { AgentSessionImpl, type AgentSessionOptions } from "../agent/session.js";
import { DEFAULT_SUBAGENT_CONCURRENCY } from "../agent/session-subagent.js";
import type { AgentSession, CacheSettings } from "../agent/types.js";
import { WARMING_MODES, type WarmingMode } from "../ai/cache/types.js";
import { isOverflowErrorText } from "../ai/overflow.js";
import type { Model, ModelThinkingLevel } from "../ai/types.js";
import { CACHE_RETENTIONS, type AmaConfig } from "../config/types.js";
import { AmaError, StartupError } from "../errors.js";
import type { InstructionSource } from "../host/types.js";
import { ApprovalBrokerChain, DEFAULT_APPROVAL_TIMEOUT_MS } from "../permissions/broker.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import { SessionManager } from "../session/manager.js";
import { sessionDirForCwd } from "../session/store.js";
import { createCheckpointBackendFactory, resolveCheckpointSettings } from "../checkpoints/index.js";
import type { Skill } from "../skills/discover.js";
import { expandSkillCommand } from "../skills/expand.js";
import { formatSkillIndex } from "../skills/index-prompt.js";
import { expandPromptCommand, type PromptTemplate } from "../skills/templates.js";
import { PresetToolRegistry } from "../tools/presets.js";
import type { ToolDefinition } from "../tools/types.js";
import { openSession } from "./compose-store.js";
import { bridgeEvent } from "./compose-events.js";
import { composeExtensions } from "./compose-extensions.js";
import { attachMemory, withMemorySection } from "./compose-memory.js";
import type { MemoryRuntime } from "../memory/runtime.js";
import type { SessionAssembly } from "./deps.js";
import { ExitCode } from "./exit-codes.js";
import type { Runtime } from "./runtime.js";
import { msg } from "../i18n/index.js";
import type { HookContextOverrides } from "../hooks/types.js";

export { bridgeEvent } from "./compose-events.js";

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
  /** [S2] tools.create 算出的 bash 沙箱设定，permissions.create 用同一份。 */
  bashSandbox?: BashSandbox;
  /** [W6-M] tools.create 收到的记忆运行期（未开启为 undefined）。 */
  memory?: MemoryRuntime | undefined;
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
  /** 前台会话的 SessionStart Hook additionalContext（初始会话现取 assembly 的）。 */
  hookContext: () => string | undefined;
  /** [ACP-C0] 每个会话自己的 additionalContext（兄弟会话各有各的）。 */
  hookContexts: WeakMap<AgentSession, () => string | undefined>;
  /** [ACP-C0] 未 dispose 的会话（宿主后注册的工具追加给它们全部）。 */
  live: Set<AgentSessionImpl>;
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
    log(
      "warn",
      msg().cli.composeSession.instructionsReadFailed(source.path, (error as Error).message),
    );
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

/** [W6-S] D22：回复语言规则（发给模型，固定英文）。 */
export function replyLanguageRule(language: string): string {
  return `Reply to the user in ${language}.`;
}

function systemInput(
  record: SessionRecord,
  active: readonly string[],
  hookContextOf: () => string | undefined,
): NonNullable<AgentSessionOptions["system"]> {
  const system: NonNullable<AgentSessionOptions["system"]> = { contextFiles: contextFiles(record) };
  const override = record.assembly.overrides?.systemPrompt;
  if (override?.mode === "replace") system.preamble = override.text;
  else if (override !== undefined) system.extraRules = [override.text];
  // [W6-S] D22 ui.replyLanguage：会话开始在 rules 节末尾追加一句英文规则；不设时零字节变化
  const reply = record.assembly.config.ui?.replyLanguage?.trim();
  if (reply) system.extraRules = [...(system.extraRules ?? []), replyLanguageRule(reply)];
  const index = formatSkillIndex(record.state.skills, {
    hasSkillTool: false,
    hasReadTool: active.includes("read"),
  });
  if (index !== "") system.skillsIndex = index;
  const host = hostInstructions(record);
  if (host.length > 0) system.hostInstructions = host;
  const hookContext = hookContextOf();
  if (hookContext !== undefined && hookContext !== "") system.hookContext = hookContext;
  return system;
}

/** 提示展开前刷新会晚到的系统提示材料（值不变则不产生补丁）。 */
function refreshSystem(record: SessionRecord, session: AgentSessionImpl): void {
  const patch: Parameters<AgentSessionImpl["updateSystem"]>[0] = {};
  const hookContext = (record.hookContexts.get(session) ?? record.hookContext)();
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
    throw new AmaError(
      "skill_not_found",
      msg().cli.composeSession.unknownSkill(skill.name, skill.available),
    );
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
    else warn(msg().cli.composeSession.invalidCacheWarming(warming));
  }
  const retention = env["AMA_CACHE_RETENTION"];
  if (retention !== undefined && retention !== "") {
    const value = retention as CacheSettings["retention"];
    if (CACHE_RETENTIONS.includes(value)) settings.retention = value;
    else warn(msg().cli.composeSession.invalidCacheRetention(retention));
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
    warn(msg().cli.composeSession.invalidIdleTimeout(raw));
  }
  return config.request?.idleTimeoutMs;
}

function buildSession(
  record: SessionRecord,
  manager: SessionManager,
  model: Model,
  thinkingLevel: ModelThinkingLevel,
  /** 这个会话的 SessionStart additionalContext；缺省沿用前台的。 */
  hookContext: () => string | undefined = record.hookContext,
  /** false：兄弟会话，不改工具工厂的当前会话。 */
  foreground = true,
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
    system: withMemorySection(
      systemInput(record, active, hookContext),
      record.state.memory,
      manager,
    ),
    compaction: { ...config.compaction },
    retry: { ...config.retry },
    expandPrompt: (text) => expandPrompt(record, session as AgentSessionImpl, text),
    isContextOverflow: isOverflowErrorText,
    subagents:
      registry.get("task") === undefined
        ? false
        : { maxConcurrent: config.subagents?.maxConcurrent ?? DEFAULT_SUBAGENT_CONCURRENCY },
    log: record.log,
    cache: cacheSettingsFrom(config, process.env, (message) => record.log("warn", message)),
    warmingDecider: () => assembly.host.warmingDecider?.(),
    // [W5-C0] 会话扩展（组装表在 compose-extensions.ts）
    extensions: composeExtensions({ assembly, env: process.env, log: record.log }),
  };
  // [W5-H2] 预算：--max-turns / --max-cost 覆盖 config limits.*，由 limits 扩展执行（agent/limits.ts）
  const limits = resolveLimits(config.limits, {
    maxTurns: assembly.overrides?.maxTurns,
    maxCostUsd: assembly.overrides?.maxCostUsd,
  });
  if (limits !== undefined) options.limits = limits;
  if (config.fallbackModel !== undefined) options.fallbackModel = config.fallbackModel;
  const idle = idleTimeoutFrom(config, process.env, (message) => record.log("warn", message));
  if (idle !== undefined) options.idleTimeoutMs = idle;
  const autoModel = config.permission?.autoModel;
  if (autoModel !== undefined) options.permissionClassifier = { model: autoModel };
  const maxChars = config.tools?.maxToolResultChars;
  if (maxChars !== undefined) options.maxToolResultChars = maxChars;
  const hostId = assembly.host.handle?.adapter.id;
  if (hostId !== undefined) options.hostId = hostId;
  // [RW-B] 回滚：中断即撤回与检查点后端（内存会话不调工厂；mode off 时工厂返回 undefined）
  if (config.ui?.restoreOnCancel === false) options.restoreOnCancel = false;
  options.checkpoints = createCheckpointBackendFactory({
    ...resolveCheckpointSettings(config, process.env, (message) => record.log("warn", message)),
    dataDir: assembly.paths.dataDir,
    sessionsRoot: assembly.paths.sessionDir,
  });
  session = new AgentSessionImpl(options);
  attachMemory(session, record.state.memory);
  session.subscribe((event) => bridgeEvent(event, assembly.events));
  records.set(session, record);
  record.hookContexts.set(session, hookContext);
  record.live.add(session);
  if (foreground) record.state.session = session;
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
    throw new AmaError("invalid_arguments", msg().cli.composeSession.notSessionManager);
  }
  const { model } = assembly;
  if (assembly.providers.getApi(model.api) === undefined) {
    throw new StartupError(
      "provider_not_found",
      msg().cli.composeSession.apiNotImplemented(
        `${model.provider}/${model.id}`,
        model.api,
        model.api === "google-generative-ai",
      ),
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
    hookContexts: new WeakMap(),
    live: new Set(),
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
      for (const live of record.live) {
        try {
          live.addTool(tool, active);
        } catch (error) {
          record.log(
            "warn",
            msg().cli.composeSession.appendToolFailed(tool.name, (error as Error).message),
          );
        }
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
    throw new AmaError("not_implemented", msg().cli.composeSession.notComposed);
  const old = record.current;
  if (old.state.isStreaming)
    throw new AmaError("busy", msg().cli.composeSession.switchWhileStreaming);
  const { assembly } = record;
  const sessionDir = assembly.paths.sessionDir;
  let manager: SessionManager;
  let source: "new" | "resume" | "fork";
  switch (request.kind) {
    case "new":
      manager =
        assembly.overrides?.noSession === true
          ? SessionManager.inMemory(old.cwd)
          : SessionManager.create(sessionDirForCwd(sessionDir, old.cwd), old.cwd);
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
  record.live.delete(old);
  if (assembly.permission instanceof PermissionPipeline) assembly.permission.clearSessionGrants();
  let hookContext: string | undefined;
  record.hookContext = () => hookContext;
  const next = buildSession(record, manager, old.model(), old.thinkingLevel(), record.hookContext);
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

function requireRecord(target: Runtime | AgentSession): SessionRecord {
  const record = recordOf(target);
  if (record === undefined)
    throw new AmaError("not_implemented", msg().cli.composeSession.notComposed);
  return record;
}

/** 按某个会话覆盖 Hook 公共字段（兄弟会话的 SessionStart / SessionEnd 不该带前台会话的 id）。 */
function hookFieldsOf(session: AgentSession): HookContextOverrides {
  const file = session.state.sessionFile;
  return {
    sessionId: session.state.sessionId,
    sessionFile: file,
    transcriptPath: file,
    cwd: session.state.cwd,
    model: session.state.model,
    permissionMode: session.state.permissionMode,
  };
}

/**
 * [ACP-C0] 不替换当前会话、不 dispose、不跑 SessionEnd Hook 地再建一个会话（ACP 多会话）。
 * 宿主总线发 `session_start`，再以新会话的公共字段跑 SessionStart Hook（additionalContext 只给它）。
 * 会话自身的 `session_start` 事件由模式在订阅之后调 `announceStart` 发。
 */
export async function createSessionAlongside(
  target: Runtime | AgentSession,
  request: Extract<SwitchRequest, { kind: "new" | "resume" }>,
  options: { createIfMissing?: boolean } = {},
): Promise<AgentSessionImpl> {
  const record = requireRecord(target);
  const current = record.current;
  const { assembly } = record;
  const sessionDir = assembly.paths.sessionDir;
  const fresh = (id?: string): SessionManager =>
    assembly.overrides?.noSession === true
      ? SessionManager.inMemory(current.cwd)
      : SessionManager.create(
          sessionDirForCwd(sessionDir, current.cwd),
          current.cwd,
          id !== undefined ? { id } : {},
        );
  let manager: SessionManager;
  if (request.kind === "new") manager = fresh();
  else {
    try {
      manager = openSession({ kind: "resume", id: request.id }, { sessionDir, cwd: current.cwd });
    } catch (error) {
      // [ACP] 空会话不落盘：进程重启后客户端再打开它时按原 id 新建一个空会话（调用方负责校验 id）
      if (
        options.createIfMissing !== true ||
        !(error instanceof AmaError && error.code === "session_not_found")
      )
        throw error;
      manager = fresh(request.id);
    }
  }
  let hookContext: string | undefined;
  const next = buildSession(
    record,
    manager,
    current.model(),
    current.thinkingLevel(),
    () => hookContext,
    false,
  );
  const file = next.state.sessionFile;
  await assembly.events.emit("session_start", {
    sessionId: next.state.sessionId,
    ...(file !== undefined ? { sessionFile: file } : {}),
    cwd: next.cwd,
    reason: request.kind,
  });
  const outcome = await assembly.hooks
    .run("SessionStart", { source: request.kind }, undefined, hookFieldsOf(next))
    .catch(() => undefined);
  hookContext = outcome?.additionalContext;
  return next;
}

/**
 * [ACP-C0] 把宿主（HostApi `session.*`）、Hook 公共字段与工具工厂的「当前会话」切到 `session`，
 * 清掉「本会话允许」的记忆。返回是否真的切换了（已是前台时什么都不做）。
 */
export function setForegroundSession(
  target: Runtime | AgentSession,
  session: AgentSessionImpl,
): boolean {
  const record = requireRecord(target);
  if (records.get(session) !== record || !record.live.has(session))
    throw new AmaError("invalid_arguments", msg().cli.composeSession.notLiveSession);
  if (record.current === session) return false;
  record.current = session;
  record.state.session = session;
  record.hookContext = record.hookContexts.get(session) ?? (() => undefined);
  record.assembly.onSessionReplaced(session);
  const permission = record.assembly.permission;
  if (permission instanceof PermissionPipeline) permission.clearSessionGrants();
  return true;
}

/**
 * [ACP-C0] 释放一个兄弟会话：以它的公共字段跑 SessionEnd Hook（reason `switch`）后 dispose。
 * 它是前台时先把前台切到 `fallback`。运行中的会话要先 abort 并等空闲。
 */
export async function disposeSessionAlongside(
  target: Runtime | AgentSession,
  session: AgentSessionImpl,
  fallback: AgentSessionImpl,
): Promise<void> {
  const record = requireRecord(target);
  if (!record.live.has(session)) return;
  if (session.state.isStreaming)
    throw new AmaError("busy", msg().cli.composeSession.switchWhileStreaming);
  if (record.current === session) {
    if (fallback === session)
      throw new AmaError("invalid_arguments", msg().cli.composeSession.notLiveSession);
    setForegroundSession(target, fallback);
  }
  await record.assembly.hooks
    .run("SessionEnd", { reason: "switch" }, undefined, hookFieldsOf(session))
    .catch(() => undefined);
  await session.dispose();
  record.live.delete(session);
}
