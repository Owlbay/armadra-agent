/**
 * 权限管线（设计 §6.3 第 3 步、§7.1、§7.4、D11）。[B3]
 *
 *   ① deny 规则 ∪ Hook deny                         → deny
 *   ② 危险命令（仅 bash）                            → ask（无人值守 deny），之后各步不能放宽
 *   ③ 模式：plan  read 允许，write / execute deny（[W5-F] 细化见 {@link planDecision}：只读 bash、
 *                 task 放行，`todo set / update` 拒绝）
 *           default  read 允许，write / execute 问
 *           auto-edit read / write 允许，execute 问
 *           full-auto 全部允许
 *   ④ allow 规则 ∪ Hook allow ∪ allow_session 记忆：把 ③ 的 ask 变 allow（不越过 ①②，不改 plan 的 deny）；
 *      Hook ask：随后把 allow 变 ask——净效果是 Hook ask 总得到 ask（reason "hook"，对话框显示 Hook 的 reason）
 *   无人值守：最终 ask → deny。
 *
 * auto（§7.4）：①② 同上；规则层再把受保护路径、项目外写入、网络命令、删除类命令判 ask（不能被 allow
 * 规则越过）；Hook ask → ask；allow 规则 / Hook allow / 会话记忆 → allow；静态判定（只读工具、项目内写入、
 * 安全名单里的 bash）→ allow；都没决定 → ask 且 `classify: true`，由调用方问模型分类器（分类器只能
 * 把它变 allow）。每个结论带 `auto{layer, decision, reason}`。
 *
 * allowlist：①② 同上；只读工具、只读 bash（[W5-F] 与 plan 同一子集，保持 plan ⊆ allowlist）与
 * allow 规则 / Hook allow 命中放行，task 同 plan 放行（子会话共用本管线），其余 deny——从不询问
 * （危险命令、Hook ask 也 deny）。
 *
 * allow_session 记忆（内存，不落盘）：bash 记命令的前两个词（`npm test`），之后以它开头的命令
 * 命中；带 path 的工具记文件所在目录，之后该目录下的路径命中；其它工具只记工具名。
 * 记忆只作用于第 ③ 步模式产生的 ask（auto 里只作用于规则层之后）。
 *
 * [S2] bash 沙箱（docs/permissions.md「判定顺序」）：default / auto-edit 下，bash 调用若将在 OS 沙箱内
 * 运行且沙箱拒绝网络、没请求 `sandbox: false`、命令文本不碰机密路径、嵌套不超深，第 ③ 步的 ask 变
 * allow（`sandboxed: true`）；①② 与 Hook ask 照旧优先。auto 下沙箱不直接放行，只作为分类器输入；
 * 请求 `sandbox: false` 越出沙箱时规则层询问（allow 规则 / Hook allow / 会话记忆仍可放行）。
 *
 * 包装里的命令（`sh -c '…'`、`eval`、`xargs`、`find -exec`，见 dangerous.ts）逐层核对：deny 规则命中
 * 任一层即 deny；allow 规则与会话记忆要求外层与每一层嵌套命令都被覆盖，嵌套超深时不放行。
 */

import { dirname, sep } from "node:path";
import { isBackgroundJobQuery } from "../tools/background-jobs.js";
import type {
  ApprovalReason,
  AutoAuditEntry,
  AutoDecision,
  Decision,
  PermissionCheckInput,
  PermissionMode,
  PermissionPipelineApi,
  PermissionVerdict,
  Rule,
} from "./types.js";
import type { ToolPermission } from "../tools/types.js";
import {
  findAllowRule,
  findDenyRule,
  inputCommand,
  inputPath,
  normalizeCommand,
  splitShellSegments,
} from "./rules.js";
import { collectNestedCommands, matchDangerous } from "./dangerous.js";
import { analyzeBashForAuto, secretReferenceReason } from "./auto-safe.js";
import { runsSandboxed, wantsUnsandboxed, type BashSandbox } from "../sandbox/bash.js";
import { isReadonlyBash } from "./readonly-bash.js";
import type { PlanBashMode } from "../config/types-w5.js";
import { secretPathReason, writeProtectionReason } from "./protected.js";
import { AUTO_AUDIT_LIMIT } from "./types.js";

/** bash 调用拆成「外层 + 每层嵌套命令」各自的输入；嵌套超深时 tooDeep 为真。非 bash 原样返回。 */
function layeredInputs(toolName: string, input: unknown): { inputs: unknown[]; tooDeep: boolean } {
  const command = toolName === "bash" ? inputCommand(input) : undefined;
  if (command === undefined) return { inputs: [input], tooDeep: false };
  const nested = collectNestedCommands(command);
  return {
    inputs: [input, ...nested.commands.map((c) => ({ ...(input as object), command: c }))],
    tooDeep: nested.tooDeep,
  };
}

/**
 * 第 ③ 步的模式真值表（不看输入）。auto 的 write / execute 在这里是 ask，真正的结论由规则层、
 * 静态判定与分类器给出；allowlist 的 write / execute 是 deny（allow 规则可放行）。
 */
export function modeDecision(mode: PermissionMode, permission: ToolPermission): Decision {
  if (permission === "read" || mode === "full-auto") return "allow";
  if (mode === "plan" || mode === "allowlist") return "deny";
  if (mode === "auto-edit") return permission === "write" ? "allow" : "ask";
  return "ask";
}

/** [W5-F] plan 模式拒绝写 / 执行时的说明：带指引，提醒被压缩掉后模型也能从拒绝结果里恢复。 */
export const PLAN_MODE_MESSAGE =
  "Plan mode is active: write/execute tools are disabled. Finish the plan with a <proposed_plan> block.";

/** [W5-F] plan 下 `todo set / update` 的拒绝说明（计划与清单分开，避免跳过审批）。 */
export const PLAN_TODO_MESSAGE =
  "Plan mode is active: the todo list is created from the approved plan. Write the steps in a <proposed_plan> block instead.";

/**
 * [W5-F] plan 模式第 ③ 步（输入可见，docs/wave5-plan.md §6.2）：
 * read 放行（`todo` 只放行 get）；bash 按 `plan.bash`（readonly：只读子集放行其余拒绝；ask：其余询问；
 * deny：全拒）；task 放行（子会话共用同一管线，同样处在 plan）；其余 write / execute 拒绝。
 * 返回 undefined = 交给通常的模式真值表。
 */
export function planDecision(
  input: Pick<PermissionCheckInput, "toolName" | "permission" | "input">,
  planBash: PlanBashMode,
  cwd: string,
  projectRoot = cwd,
): { decision: Decision; message?: string } {
  const { toolName, permission } = input;
  if (toolName === "todo") {
    const action =
      typeof input.input === "object" && input.input !== null
        ? (input.input as Record<string, unknown>)["action"]
        : undefined;
    return action === "get"
      ? { decision: "allow" }
      : { decision: "deny", message: PLAN_TODO_MESSAGE };
  }
  if (permission === "read") return { decision: "allow" };
  if (toolName === "task") return { decision: "allow" };
  if (toolName === "bash") {
    if (planBash === "deny") return { decision: "deny", message: PLAN_MODE_MESSAGE };
    const command = inputCommand(input.input);
    if (command !== undefined && isReadonlyBash(command, { cwd, projectRoot }))
      return { decision: "allow" };
    return planBash === "ask"
      ? { decision: "ask" }
      : { decision: "deny", message: PLAN_MODE_MESSAGE };
  }
  return { decision: "deny", message: PLAN_MODE_MESSAGE };
}

export const UNATTENDED_MESSAGE =
  "This tool call requires approval, but no one is available to approve it (unattended mode).";

export const ALLOWLIST_MESSAGE =
  'Not in the allowlist (不在允许名单): permission mode "allowlist" only runs read-only tools and calls matched by an allow rule, and never asks.';

/** 审计摘要：bash 取命令，带 path 的取路径，其它取工具名；单行、截断。 */
function auditSummary(toolName: string, input: unknown): string {
  const command = inputCommand(input);
  const raw =
    command ??
    (typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)["path"]
      : undefined);
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : toolName;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

interface SessionGrant {
  toolName: string;
  kind: "command" | "dir" | "any";
  prefix: string;
}

export function sessionGrantFor(toolName: string, input: unknown, cwd: string): SessionGrant {
  const command = inputCommand(input);
  if (command !== undefined) {
    const words = normalizeCommand(command).split(" ").slice(0, 2);
    return { toolName, kind: "command", prefix: words.join(" ") };
  }
  const path = inputPath(toolName, input, cwd);
  if (path !== undefined) return { toolName, kind: "dir", prefix: dirname(path) };
  return { toolName, kind: "any", prefix: "" };
}

function grantCovers(grant: SessionGrant, toolName: string, input: unknown, cwd: string): boolean {
  if (grant.toolName !== toolName) return false;
  if (grant.kind === "any") return true;
  if (grant.kind === "command") {
    const command = inputCommand(input);
    if (command === undefined || /\$\(|`/.test(command)) return false;
    const segments = splitShellSegments(command);
    return (
      segments.length > 0 &&
      segments.every((s) => s === grant.prefix || s.startsWith(`${grant.prefix} `))
    );
  }
  const path = inputPath(toolName, input, cwd);
  return path !== undefined && (path === grant.prefix || path.startsWith(grant.prefix + sep));
}

export interface PermissionPipelineOptions {
  mode: PermissionMode;
  rules: readonly Rule[];
  cwd: string;
  /** auto：项目根（受保护写入与分类器输入用），缺省 = cwd。 */
  projectRoot?: string;
  /** auto：安全名单追加（`permission.autoSafeCommands`）。 */
  autoSafeCommands?: readonly string[];
  /** [W5-F] plan 模式下的 bash（config `plan.bash`），缺省 readonly。 */
  planBash?: PlanBashMode;
  /** [S2] bash 的 OS 沙箱设定（与 bash 工具用同一份，保证「会不会在沙箱里跑」两边结论一致）。 */
  bashSandbox?: BashSandbox;
}

export class PermissionPipeline implements PermissionPipelineApi {
  private currentMode: PermissionMode;
  private readonly ruleList: Rule[];
  private readonly grants: SessionGrant[] = [];
  private readonly audit: AutoAuditEntry[] = [];
  readonly cwd: string;
  readonly projectRoot: string;
  readonly autoSafeCommands: readonly string[];
  private planBashMode: PlanBashMode;
  readonly bashSandbox: BashSandbox | undefined;

  constructor(options: PermissionPipelineOptions) {
    this.bashSandbox = options.bashSandbox;
    this.currentMode = options.mode;
    this.planBashMode = options.planBash ?? "readonly";
    this.ruleList = [...options.rules];
    this.cwd = options.cwd;
    this.projectRoot = options.projectRoot ?? options.cwd;
    this.autoSafeCommands = [...(options.autoSafeCommands ?? [])];
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
  }

  /** [W5-F] config `plan.bash`（plan 扩展在会话装配时设置）。 */
  get planBash(): PlanBashMode {
    return this.planBashMode;
  }

  setPlanBash(mode: PlanBashMode): void {
    this.planBashMode = mode;
  }

  get rules(): readonly Rule[] {
    return this.ruleList;
  }

  rememberForSession(toolName: string, input: unknown): void {
    this.grants.push(sessionGrantFor(toolName, input, this.cwd));
  }

  clearSessionGrants(): void {
    this.grants.length = 0;
  }

  recordAutoDecision(toolName: string, input: unknown, decision: AutoDecision): void {
    this.audit.push({
      ...decision,
      at: Date.now(),
      toolName,
      summary: auditSummary(toolName, input),
    });
    if (this.audit.length > AUTO_AUDIT_LIMIT)
      this.audit.splice(0, this.audit.length - AUTO_AUDIT_LIMIT);
  }

  autoDecisions(): readonly AutoAuditEntry[] {
    return [...this.audit];
  }

  check(request: PermissionCheckInput): PermissionVerdict {
    // [W5-H2] 后台 bash 的查询（bash{job, action}，不带 command）只读 / 结束本会话自己启动的任务：按 read
    const input: PermissionCheckInput = isBackgroundJobQuery(request.toolName, request.input)
      ? { ...request, permission: "read" }
      : request;
    const verdict = this.evaluate(input);
    if (this.currentMode === "auto" && verdict.auto === undefined) {
      verdict.auto = {
        layer: "rule",
        decision: verdict.decision,
        reason: verdict.message ?? verdict.step,
      };
    }
    if (verdict.decision === "ask" && input.unattended) {
      return { ...verdict, decision: "deny", message: UNATTENDED_MESSAGE };
    }
    return verdict;
  }

  private evaluate(input: PermissionCheckInput): PermissionVerdict {
    const { toolName, permission } = input;
    // ① deny
    const layers = layeredInputs(toolName, input.input);
    let deny: Rule | undefined;
    for (const layer of layers.inputs) {
      deny = findDenyRule(this.ruleList, toolName, layer, this.cwd);
      if (deny) break;
    }
    if (deny) {
      return {
        decision: "deny",
        step: "deny-rule",
        rule: deny,
        message: `Denied by permission rule ${deny.raw} (${deny.source})`,
      };
    }
    if (input.hookDecision === "deny") {
      return {
        decision: "deny",
        step: "hook-deny",
        message: input.hookReason ?? "Denied by a PreToolUse hook",
      };
    }
    // ② 危险命令
    const command = toolName === "bash" ? inputCommand(input.input) : undefined;
    const danger = command !== undefined ? matchDangerous(command) : undefined;
    if (danger) {
      const message = `Potentially dangerous command: ${danger.description}`;
      if (this.currentMode === "allowlist") {
        return { decision: "deny", step: "allowlist", message: `${ALLOWLIST_MESSAGE} ${message}` };
      }
      const verdict: PermissionVerdict = {
        decision: "ask",
        step: "dangerous",
        approvalReason: "dangerous",
        message,
      };
      if (this.currentMode === "auto") {
        verdict.auto = { layer: "rule", decision: "ask", reason: danger.description };
      }
      return verdict;
    }
    if (this.currentMode === "auto") return this.evaluateAuto(input, layers, command);
    if (this.currentMode === "allowlist") return this.evaluateAllowlist(input, layers);
    // ③ 模式（plan 细化见 planDecision）
    const plan =
      this.currentMode === "plan"
        ? planDecision(input, this.planBashMode, this.cwd, this.projectRoot)
        : undefined;
    const byMode = plan?.decision ?? modeDecision(this.currentMode, permission);
    if (byMode === "deny") {
      return {
        decision: "deny",
        step: "mode",
        message: plan?.message ?? PLAN_MODE_MESSAGE,
      };
    }
    let verdict: PermissionVerdict =
      byMode === "allow"
        ? { decision: "allow", step: "mode" }
        : { decision: "ask", step: "mode", approvalReason: "mode" };
    // ④ allow 规则 / Hook allow / 会话记忆
    if (verdict.decision === "ask") {
      const allow = layers.tooDeep
        ? undefined
        : findAllowRule(this.ruleList, toolName, input.input, this.cwd);
      const allowAll =
        allow !== undefined &&
        layers.inputs.every((l) => findAllowRule(this.ruleList, toolName, l, this.cwd));
      const granted =
        !layers.tooDeep &&
        layers.inputs.every((l) => this.grants.some((g) => grantCovers(g, toolName, l, this.cwd)));
      if (allowAll) verdict = { decision: "allow", step: "allow-rule", rule: allow };
      else if (input.hookDecision === "allow") verdict = { decision: "allow", step: "hook" };
      else if (granted) {
        verdict = { decision: "allow", step: "session" };
      } else if (
        (this.currentMode === "default" || this.currentMode === "auto-edit") &&
        this.sandboxAllows(input, command, layers.tooDeep)
      ) {
        verdict = { decision: "allow", step: "mode", sandboxed: true };
      }
    }
    if (input.hookDecision === "ask") {
      const reason: ApprovalReason = "hook";
      verdict = {
        decision: "ask",
        step: "hook",
        approvalReason: reason,
        ...(input.hookReason !== undefined ? { message: input.hookReason } : {}),
      };
    }
    return verdict;
  }

  /**
   * [S2] default / auto-edit 的「沙箱内免审批」：将在沙箱内运行、沙箱拒绝网络（联网可外带数据）、
   * 命令文本不碰机密路径（沙箱挡不住读工作区里的 `.env`）、嵌套不超深。
   */
  private sandboxAllows(
    input: PermissionCheckInput,
    command: string | undefined,
    tooDeep: boolean,
  ): boolean {
    if (input.toolName !== "bash" || command === undefined || tooDeep) return false;
    if (!runsSandboxed(this.bashSandbox, input.input)) return false;
    if (this.bashSandbox?.network !== "deny") return false;
    return secretReferenceReason(command, this.cwd) === undefined;
  }

  /** [S2] 沙箱生效时请求 `sandbox: false` 越出沙箱。 */
  private escapesSandbox(input: PermissionCheckInput): boolean {
    return (
      input.toolName === "bash" &&
      this.bashSandbox?.active === true &&
      wantsUnsandboxed(input.input)
    );
  }

  /** allow 规则（每层都覆盖）/ Hook allow / 会话记忆；都不命中返回 undefined。 */
  private allowedBy(
    input: PermissionCheckInput,
    layers: { inputs: unknown[]; tooDeep: boolean },
    useGrants: boolean,
  ): PermissionVerdict | undefined {
    const { toolName } = input;
    const allow = layers.tooDeep
      ? undefined
      : findAllowRule(this.ruleList, toolName, input.input, this.cwd);
    if (
      allow !== undefined &&
      layers.inputs.every((l) => findAllowRule(this.ruleList, toolName, l, this.cwd))
    ) {
      return { decision: "allow", step: "allow-rule", rule: allow };
    }
    if (input.hookDecision === "allow") return { decision: "allow", step: "hook" };
    if (
      useGrants &&
      !layers.tooDeep &&
      layers.inputs.every((l) => this.grants.some((g) => grantCovers(g, toolName, l, this.cwd)))
    ) {
      return { decision: "allow", step: "session" };
    }
    return undefined;
  }

  /** auto 规则层（受保护路径、项目外写入、网络、删除类）要询问的原因。 */
  private autoRuleReason(
    input: PermissionCheckInput,
    command: string | undefined,
  ): { ask?: string; bashSafe?: boolean; bashReason?: string } {
    if (command !== undefined) {
      const analysis = analyzeBashForAuto(command, {
        cwd: this.cwd,
        projectRoot: this.projectRoot,
        extraSafe: this.autoSafeCommands,
      });
      const out: { ask?: string; bashSafe?: boolean; bashReason?: string } = {
        bashSafe: analysis.safe,
        bashReason: analysis.reason,
      };
      if (analysis.ask !== undefined) out.ask = analysis.ask;
      return out;
    }
    const raw =
      typeof input.input === "object" && input.input !== null
        ? (input.input as Record<string, unknown>)["path"]
        : undefined;
    if (typeof raw !== "string" && input.permission !== "write") return {};
    const path = inputPath(input.toolName, input.input, this.cwd);
    if (path === undefined) return {};
    const secret = secretPathReason(path);
    if (secret !== undefined) return { ask: secret };
    if (input.permission === "write") {
      const reason = writeProtectionReason(path, this.projectRoot);
      if (reason !== undefined) return { ask: reason };
    }
    return {};
  }

  private evaluateAuto(
    input: PermissionCheckInput,
    layers: { inputs: unknown[]; tooDeep: boolean },
    command: string | undefined,
  ): PermissionVerdict {
    const rule = (decision: Decision, reason: string): AutoDecision => ({
      layer: "rule",
      decision,
      reason,
    });
    const checked = this.autoRuleReason(input, command);
    if (checked.ask !== undefined) {
      return {
        decision: "ask",
        step: "auto-rule",
        approvalReason: "mode",
        message: `Auto mode asks before this: ${checked.ask}`,
        auto: rule("ask", checked.ask),
      };
    }
    if (input.hookDecision === "ask") {
      const verdict: PermissionVerdict = {
        decision: "ask",
        step: "hook",
        approvalReason: "hook",
        auto: rule("ask", input.hookReason ?? "PreToolUse hook asked"),
      };
      if (input.hookReason !== undefined) verdict.message = input.hookReason;
      return verdict;
    }
    const allowed = this.allowedBy(input, layers, true);
    if (allowed !== undefined) {
      const reason =
        allowed.step === "allow-rule"
          ? `allow rule ${allowed.rule?.raw ?? ""}`.trim()
          : allowed.step === "hook"
            ? "PreToolUse hook allowed"
            : "allowed for this session";
      return { ...allowed, auto: rule("allow", reason) };
    }
    if (this.escapesSandbox(input)) {
      const why = "runs outside the OS sandbox (sandbox:false)";
      return {
        decision: "ask",
        step: "auto-rule",
        approvalReason: "mode",
        message: `Auto mode asks before this: ${why}`,
        auto: rule("ask", why),
      };
    }
    const fixed = (reason: string): PermissionVerdict => ({
      decision: "allow",
      step: "auto-static",
      auto: { layer: "static", decision: "allow", reason },
    });
    if (input.permission === "read") return fixed("read-only tool");
    if (command !== undefined && checked.bashSafe === true) {
      return fixed(checked.bashReason ?? "safe command");
    }
    if (command === undefined && input.permission === "write") {
      const path = inputPath(input.toolName, input.input, this.cwd);
      if (path !== undefined) return fixed("write inside the project");
    }
    return {
      decision: "ask",
      step: "auto-classify",
      approvalReason: "mode",
      classify: true,
      ...(command !== undefined && runsSandboxed(this.bashSandbox, input.input)
        ? { sandboxed: true }
        : {}),
      auto: {
        layer: "classifier",
        decision: "ask",
        reason: checked.bashReason ?? `${input.toolName} needs a judgement`,
      },
    };
  }

  private evaluateAllowlist(
    input: PermissionCheckInput,
    layers: { inputs: unknown[]; tooDeep: boolean },
  ): PermissionVerdict {
    const deny = (why?: string): PermissionVerdict => ({
      decision: "deny",
      step: "allowlist",
      message: why === undefined ? ALLOWLIST_MESSAGE : `${ALLOWLIST_MESSAGE} ${why}`,
    });
    if (input.hookDecision === "ask") return deny(input.hookReason);
    // task 与 plan 同样放行：子会话共用本管线，同样只放行只读与名单内调用
    if (input.permission === "read" || input.toolName === "task")
      return { decision: "allow", step: "mode" };
    const command = input.toolName === "bash" ? inputCommand(input.input) : undefined;
    if (
      command !== undefined &&
      isReadonlyBash(command, { cwd: this.cwd, projectRoot: this.projectRoot })
    )
      return { decision: "allow", step: "mode" };
    return this.allowedBy(input, layers, false) ?? deny();
  }
}
