/**
 * 权限管线（设计 §6.3 第 3 步、§7.1、D11）。[B3]
 *
 *   ① deny 规则 ∪ Hook deny                         → deny
 *   ② 危险命令（仅 bash）                            → ask（无人值守 deny），之后各步不能放宽
 *   ③ 模式：plan  read 允许，write / execute deny
 *           default  read 允许，write / execute 问
 *           auto-edit read / write 允许，execute 问
 *           full-auto 全部允许
 *   ④ allow 规则 ∪ Hook allow ∪ allow_session 记忆：把 ③ 的 ask 变 allow（不越过 ①②，不改 plan 的 deny）；
 *      Hook ask：随后把 allow 变 ask——净效果是 Hook ask 总得到 ask（reason "hook"，对话框显示 Hook 的 reason）
 *   无人值守：最终 ask → deny。
 *
 * allow_session 记忆（内存，不落盘）：bash 记命令的前两个词（`npm test`），之后以它开头的命令
 * 命中；带 path 的工具记文件所在目录，之后该目录下的路径命中；其它工具只记工具名。
 * 记忆只作用于第 ③ 步模式产生的 ask。
 *
 * 包装里的命令（`sh -c '…'`、`eval`、`xargs`、`find -exec`，见 dangerous.ts）逐层核对：deny 规则命中
 * 任一层即 deny；allow 规则与会话记忆要求外层与每一层嵌套命令都被覆盖，嵌套超深时不放行。
 */

import { dirname, sep } from "node:path";
import type {
  ApprovalReason,
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

/** 第 ③ 步的模式真值表。 */
export function modeDecision(mode: PermissionMode, permission: ToolPermission): Decision {
  if (permission === "read" || mode === "full-auto") return "allow";
  if (mode === "plan") return "deny";
  if (mode === "auto-edit") return permission === "write" ? "allow" : "ask";
  return "ask";
}

export const UNATTENDED_MESSAGE =
  "This tool call requires approval, but no one is available to approve it (unattended mode).";

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
}

export class PermissionPipeline implements PermissionPipelineApi {
  private currentMode: PermissionMode;
  private readonly ruleList: Rule[];
  private readonly grants: SessionGrant[] = [];
  readonly cwd: string;

  constructor(options: PermissionPipelineOptions) {
    this.currentMode = options.mode;
    this.ruleList = [...options.rules];
    this.cwd = options.cwd;
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
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

  check(input: PermissionCheckInput): PermissionVerdict {
    const verdict = this.evaluate(input);
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
      return {
        decision: "ask",
        step: "dangerous",
        approvalReason: "dangerous",
        message: `Potentially dangerous command: ${danger.description}`,
      };
    }
    // ③ 模式
    const byMode = modeDecision(this.currentMode, permission);
    if (byMode === "deny") {
      return {
        decision: "deny",
        step: "mode",
        message: `Permission mode "${this.currentMode}" allows only read-only tools`,
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
}
