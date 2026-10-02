/**
 * 审批对话框（设计 §12.6）：模式层的 UI `ApprovalBroker`，底部覆盖层。[B7]
 *
 * - 标题行：来源标注 + 工具名 + 原因标签。来源（W5-U）：外部 Agent 的请求（`context.origin`）标
 *   `[claude · 会话 abc12345]`，正文取 `origin.toolCall` 的标题 / 种类 / 路径；task 子 Agent（`depth > 0`）标
 *   `[task:<agent>]`（类型名经 `ApprovalHost.taskAgent` 查注册表，查不到为 `[task]`）；外部 Agent 首次运行确认
 *   （`toolName: "task"` 且输入带 `note`）标题为「首次运行外部 Agent」，正文是说明与模式；选项始终是
 *   允许 / 本会话允许 / 拒绝三项（外部 Agent 的 `reject_always` 不由这里选）；
 * - 输入：bash 显示命令全文，write 显示路径与行数，edit 显示路径与每处修改的 −/+ 摘要，其它显示
 *   一行摘要；`v` 展开 / 收起完整输入（JSON）；
 * - 执行前预览（W3-B9a-2，`request.preview`）：输入摘要之后列出会碰到的路径与规模，danger 红、
 *   warn 黄、info 暗色；`other` 类预览与输入摘要重复，不显示；
 * - 原因：mode（当前权限模式需要确认）/ dangerous / hook + Hook 给的文本；
 * - 选项（终端界面视觉设计 v1 §3.11）：编号列表 `1. 允许  y` / `2. 本会话允许同类  a` / `3. 拒绝  n Esc`，
 *   选中行 `›` + selection 底色；缺省选中：危险命令 → 拒绝，其余 → 允许。按键 `y / a / n / Esc / Ctrl+C /
 *   1 2 3 / ↑↓ Enter / v` 都有效；
 * - 标题按原因：需要确认 / 危险命令 / Hook 要求确认（子 Agent 发起前缀 `[task] `）；边框颜色随预览严重度
 *   （danger error、warn warning）；宽 < 56 时紧凑：工具名单独一行、去掉空行、按键提示缩短；
 * - 超时与中断：broker 链在超时（缺省 10 分钟）或运行被中断时 abort `signal`，对话框关闭并返回
 *   undefined（链按 deny 处理），消息区留一行说明。
 *
 * broker 链本身串行化审批，所以同一时刻最多一个对话框。
 */

import { AUTO_LAYER_TEXT, isPermissionMode, permissionModeLabel } from "../../permissions/modes.js";
import { previewDisplayLines } from "../../permissions/preview.js";
import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "../../permissions/types.js";
import {
  Box,
  defaultKeybindings,
  matchesKey,
  padToWidth,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type Keybindings,
  type OverlayHandle,
  type Theme,
} from "../../tui.js";
import { displayPath, flat } from "./tool-summary.js";
import { toolSummary } from "./tool-view.js";

const COMMAND_LINES = 8;
const EDIT_LINES = 3;
const FULL_INPUT_LINES = 40;

export interface ApprovalHost {
  theme: Theme;
  /** task 子 Agent 的类型名（`[task:<agent>]`）；查不到返回 undefined。 */
  taskAgent?(taskId: string): string | undefined;
  /** `task` 调用的 agent 是外部 Agent 时返回 runner（见 approval-merge.ts）。 */
  externalRunner?(agent: string): string | undefined;
  keybindings?: Keybindings;
  /** 路径显示的基准。 */
  cwd?: string;
  /** 当前权限模式（原因为 mode 时显示）。 */
  permissionMode(): string;
  showOverlay(component: Component): OverlayHandle;
  /** 对话框打开 / 关闭（交互模式据此禁用编辑器提交、重画）。 */
  onOpen?(): void;
  onClose?(): void;
  /** 结果说明（消息区一行）。 */
  report?(request: ApprovalRequest, outcome: ApprovalDecision | "cancelled"): void;
}

function lines(text: string, max: number): { shown: string[]; hidden: number } {
  const all = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  while (all.length > 1 && all[all.length - 1]!.trim() === "") all.pop();
  return { shown: all.slice(0, max), hidden: Math.max(0, all.length - max) };
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

export interface DescribeOptions {
  cwd?: string;
  permissionMode?: string;
  expanded?: boolean;
  /** 紧凑（窄屏）：首行只放工具名（原因已在标题上）。 */
  compact?: boolean;
  /** task 子 Agent 的类型名（来源标注）。 */
  taskAgent?: TaskAgentLookup;
  /** `task` 调用的 agent 是外部 Agent 时返回 runner（正文写明首次运行一并确认）。 */
  externalRunner?(agent: string): string | undefined;
}

export type TaskAgentLookup = (taskId: string) => string | undefined;

/** 外部 Agent 首次运行确认（`requestApproval` 发来的 `task` 请求，输入带 `note`）。 */
export function isFirstRunRequest(request: ApprovalRequest): boolean {
  return request.toolName === "task" && typeof record(request.input)["note"] === "string";
}

/** 来源标注：`[claude · 会话 abc12345]` / `[task:explore]` / `[task]`；主会话发起为 undefined。 */
export function sourceLabel(
  request: ApprovalRequest,
  taskAgent?: TaskAgentLookup,
): string | undefined {
  const context = request.context;
  const origin = context?.origin;
  if (origin !== undefined) return `[${origin.agent} · 会话 ${origin.sessionId.slice(0, 8)}]`;
  if ((context?.depth ?? 0) <= 0) return undefined;
  const taskId = context?.taskId;
  const agent = taskId === undefined ? undefined : taskAgent?.(taskId);
  return agent === undefined ? "[task]" : `[task:${agent}]`;
}

/** 原因 → 标题文字（带来源标注）。 */
export function approvalTitle(request: ApprovalRequest, taskAgent?: TaskAgentLookup): string {
  const label = sourceLabel(request, taskAgent);
  const reason = isFirstRunRequest(request)
    ? "首次运行外部 Agent"
    : request.reason === "dangerous"
      ? "危险命令"
      : request.reason === "hook"
        ? "Hook 要求确认"
        : "需要确认";
  return label === undefined ? reason : `${label} ${reason}`;
}

/** 外部 Agent 请求的正文：标题 + 种类、涉及路径、输入摘要。 */
function originLines(
  origin: NonNullable<NonNullable<ApprovalRequest["context"]>["origin"]>,
  theme: Theme,
  cwd: string | undefined,
): string[] {
  const out: string[] = [];
  for (const path of (origin.toolCall.locations ?? []).slice(0, 3))
    out.push(theme.fg("muted", displayPath(path, cwd)));
  const hidden = (origin.toolCall.locations?.length ?? 0) - 3;
  if (hidden > 0) out.push(theme.fg("dim", `… 另 ${hidden} 个路径`));
  const summary = origin.toolCall.inputSummary;
  if (summary !== undefined && summary.trim() !== "") {
    const { shown, hidden: more } = lines(summary, COMMAND_LINES);
    out.push(...shown.map((l) => theme.fg("code", l)));
    if (more > 0) out.push(theme.fg("dim", `… 另 ${more} 行`));
  }
  return out;
}

/** 对话框正文（不含选项与按键行）。 */
export function describeRequest(
  request: ApprovalRequest,
  theme: Theme,
  options: DescribeOptions = {},
): string[] {
  const out: string[] = [];
  const label = sourceLabel(request, options.taskAgent);
  const task = label === undefined ? "" : theme.fg("warning", `${label} `);
  const origin = request.context?.origin;
  const firstRun = isFirstRunRequest(request);
  const tag =
    request.reason === "dangerous"
      ? theme.fg("error", "危险命令")
      : request.reason === "hook"
        ? theme.fg("warning", "Hook 要求确认")
        : origin !== undefined
          ? theme.fg("dim", origin.toolCall.kind)
          : theme.fg("dim", firstRun ? "首次运行" : "需要确认");
  const input = record(request.input);
  const name =
    origin !== undefined
      ? theme.bold(theme.fg("tool", flat(origin.toolCall.title)))
      : firstRun
        ? theme.bold(theme.fg("tool", `task ${String(input["agent"] ?? "")}`.trim()))
        : theme.bold(theme.fg("tool", request.toolName));
  out.push(options.compact === true ? `${task}${name}` : `${task}${name}  ${tag}`);
  const more = (n: number): string => theme.fg("dim", `… 另 ${n} 行（v 查看）`);
  if (origin !== undefined && options.expanded !== true) {
    out.push(...originLines(origin, theme, options.cwd));
  } else if (firstRun && options.expanded !== true) {
    out.push(String(input["note"]));
    const mode = input["mode"];
    if (typeof mode === "string")
      out.push(
        theme.fg("dim", `模式 ${isPermissionMode(mode) ? permissionModeLabel(mode) : mode}`),
      );
  } else if (options.expanded === true) {
    const json = JSON.stringify(request.input, null, 2) ?? String(request.input);
    const { shown, hidden } = lines(json, FULL_INPUT_LINES);
    out.push(...shown.map((l) => theme.fg("code", l)));
    if (hidden > 0) out.push(theme.fg("dim", `… 另 ${hidden} 行`));
  } else if (request.toolName === "bash" && typeof input["command"] === "string") {
    const { shown, hidden } = lines(input["command"], COMMAND_LINES);
    out.push(...shown.map((l, i) => theme.fg("code", (i === 0 ? "$ " : "  ") + l)));
    if (hidden > 0) out.push(more(hidden));
  } else if (request.toolName === "write" && typeof input["content"] === "string") {
    const count = lines(input["content"], Number.MAX_SAFE_INTEGER).shown.length;
    out.push(`${toolSummary("write", input, options.cwd)}  ${theme.fg("dim", `写入 ${count} 行`)}`);
  } else if (request.toolName === "edit" && Array.isArray(input["edits"])) {
    const edits = input["edits"] as { oldText?: unknown; newText?: unknown }[];
    out.push(
      `${toolSummary("edit", input, options.cwd)}  ${theme.fg("dim", `${edits.length} 处修改`)}`,
    );
    for (const edit of edits.slice(0, 2)) {
      for (const [sign, text, color] of [
        ["-", edit.oldText, "error"],
        ["+", edit.newText, "success"],
      ] as const) {
        if (typeof text !== "string") continue;
        const { shown, hidden } = lines(text, EDIT_LINES);
        out.push(...shown.map((l) => theme.fg(color, `${sign} ${l}`)));
        if (hidden > 0) out.push(more(hidden));
      }
    }
    if (edits.length > 2) out.push(theme.fg("dim", `… 另 ${edits.length - 2} 处`));
  } else {
    const summary = toolSummary(request.toolName, input, options.cwd);
    if (summary !== "") out.push(summary);
    const agent = input["agent"];
    const runner =
      request.toolName === "task" && typeof agent === "string"
        ? options.externalRunner?.(agent)
        : undefined;
    // 与首次运行确认合并（approval-merge.ts）：允许即同意本会话以你的登录运行该 CLI
    if (runner !== undefined)
      out.push(
        theme.fg(
          "warning",
          `外部 Agent ${agent}：以你在 ${runner} CLI 的登录运行（含本会话首次运行确认）`,
        ),
      );
  }
  const severity = request.preview?.severity;
  const color = severity === "danger" ? "error" : severity === "warn" ? "warning" : "dim";
  out.push(...previewDisplayLines(request.preview).map((l) => theme.fg(color, l)));
  const auto = request.autoDecision;
  if (origin !== undefined || firstRun) {
    // 外部 Agent 的请求由它自己的策略决定要问；首次运行确认的说明已在正文
    if (origin !== undefined) out.push(theme.fg("dim", `${origin.agent} 请求确认`));
    else out.push(theme.fg("dim", "本会话首次以你的登录运行该 CLI"));
  } else if (request.reason === "hook") {
    out.push(theme.fg("warning", `Hook：${request.hookReason ?? "（无说明）"}`));
  } else if (request.reason === "dangerous") {
    out.push(theme.fg("error", "这条命令可能有破坏性，请确认"));
  } else if (auto !== undefined) {
    out.push(theme.fg("warning", `Auto ${AUTO_LAYER_TEXT[auto.layer]}：${auto.reason}`));
  } else if (options.permissionMode !== undefined) {
    const mode = options.permissionMode;
    const label = isPermissionMode(mode) ? permissionModeLabel(mode) : mode;
    out.push(theme.fg("dim", `权限模式 ${label} 下需要确认`));
  }
  return out;
}

interface ApprovalOption {
  decision: ApprovalDecision;
  label: string;
  /** 右侧按键提示。 */
  keys: string;
}

export const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { decision: "allow", label: "允许", keys: "y" },
  { decision: "allow_session", label: "本会话允许同类", keys: "a" },
  { decision: "deny", label: "拒绝", keys: "n Esc" },
];

/** 宽度低于它（Box 外宽）时用紧凑布局。 */
const COMPACT_WIDTH = 56;

class ApprovalDialog implements Component, Focusable {
  focused = false;
  private expanded = false;
  private selected: number;

  constructor(
    private readonly request: ApprovalRequest,
    private readonly host: ApprovalHost,
    private readonly decide: (decision: ApprovalDecision) => void,
  ) {
    this.selected = request.reason === "dangerous" ? 2 : 0;
  }

  handleInput(data: string): void {
    const keys = this.host.keybindings ?? defaultKeybindings;
    const key = data.length === 1 ? data.toLowerCase() : "";
    if (key === "y") this.decide("allow");
    else if (key === "a") this.decide("allow_session");
    else if (
      key === "n" ||
      matchesKey(data, "escape") ||
      keys.matches(data, "app.clear") ||
      keys.matches(data, "tui.select.cancel")
    ) {
      this.decide("deny");
    } else if (/^[1-3]$/.test(data)) this.decide(APPROVAL_OPTIONS[Number(data) - 1]!.decision);
    else if (keys.matches(data, "tui.select.up")) {
      this.selected = (this.selected + APPROVAL_OPTIONS.length - 1) % APPROVAL_OPTIONS.length;
    } else if (keys.matches(data, "tui.select.down")) {
      this.selected = (this.selected + 1) % APPROVAL_OPTIONS.length;
    } else if (matchesKey(data, "enter")) this.decide(APPROVAL_OPTIONS[this.selected]!.decision);
    else if (key === "v") this.expanded = !this.expanded;
  }

  /** `width` 是 Box 内宽；紧凑与否按外宽（+ 4）判断。 */
  render(width: number): string[] {
    const { theme } = this.host;
    const compact = width + 4 < COMPACT_WIDTH;
    const options: DescribeOptions = {
      permissionMode: this.host.permissionMode(),
      expanded: this.expanded,
      compact,
    };
    if (this.host.cwd !== undefined) options.cwd = this.host.cwd;
    if (this.host.taskAgent !== undefined) options.taskAgent = this.host.taskAgent;
    if (this.host.externalRunner !== undefined) options.externalRunner = this.host.externalRunner;
    const body = describeRequest(this.request, theme, options);
    const lines: string[] = [];
    // 输入摘要（标题 + 命令）与预览 / 原因之间空一行
    const head = this.inputLines(body);
    for (const line of body.slice(0, head)) lines.push(...wrapTextWithAnsi(line, width));
    if (!compact && head < body.length) lines.push("");
    for (const line of body.slice(head)) lines.push(...wrapTextWithAnsi(line, width));
    if (!compact) lines.push("");
    lines.push(...this.optionLines(width, compact));
    if (!compact) lines.push("");
    const arrows = theme.glyphs.arrowUp + theme.glyphs.arrowDown;
    const hint = compact
      ? `${arrows} Enter · v 完整输入`
      : `${arrows} 选择 · Enter 确认 · v 完整输入`;
    lines.push(theme.fg("dim", hint));
    return lines.map((l) => truncateToWidth(l, width));
  }

  /** 正文里属于「输入摘要」的行数（首行 + 命令 / 路径 / 修改摘要，止于预览或原因行）。 */
  private inputLines(body: readonly string[]): number {
    const preview = previewDisplayLines(this.request.preview).length;
    const reasonLines = body.length > 0 ? 1 : 0;
    return Math.max(1, body.length - preview - reasonLines);
  }

  private optionLines(width: number, compact: boolean): string[] {
    const { theme } = this.host;
    const g = theme.glyphs;
    const keyWidth = compact ? 1 : Math.max(...APPROVAL_OPTIONS.map((o) => o.keys.length));
    return APPROVAL_OPTIONS.map((option, i) => {
      const selected = i === this.selected;
      const keys = compact ? option.keys.slice(0, 1) : option.keys;
      const left = `${selected ? g.prompt : " "} ${i + 1}. ${option.label}`;
      const right = keys.padEnd(keyWidth);
      const room = Math.max(1, width - visibleWidth(right) - 1);
      const label = selected ? theme.fg("accent", theme.bold(left)) : left;
      const line = padToWidth(truncateToWidth(label, room), room) + " " + theme.fg("dim", right);
      return selected ? theme.bg("selection", line) : line;
    });
  }

  invalidate(): void {}
}

/** UI broker：每个请求开一个底部覆盖层，等用户按键或 signal abort。 */
export class ApprovalDialogBroker implements ApprovalBroker {
  private open = 0;

  constructor(private readonly host: ApprovalHost) {}

  get isOpen(): boolean {
    return this.open > 0;
  }

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let handle: OverlayHandle | undefined;
      let settled = false;
      const settle = (decision: ApprovalDecision | undefined): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        handle?.hide();
        this.open--;
        this.host.onClose?.();
        this.host.report?.(request, decision ?? "cancelled");
        resolve(decision);
      };
      const onAbort = (): void => settle(undefined);
      const dialog = new ApprovalDialog(request, this.host, settle);
      this.open++;
      this.host.onOpen?.();
      const severity = request.preview?.severity;
      handle = this.host.showOverlay(
        new Box(dialog, {
          title: approvalTitle(request, this.host.taskAgent),
          theme: this.host.theme,
          ...(severity === "danger"
            ? { borderColor: "error" as const }
            : severity === "warn"
              ? { borderColor: "warning" as const }
              : {}),
        }),
      );
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** 结果的一行说明（消息区）。 */
export function approvalOutcomeText(
  request: ApprovalRequest,
  outcome: ApprovalDecision | "cancelled",
  taskAgent?: TaskAgentLookup,
): string {
  const label = sourceLabel(request, taskAgent);
  const origin = request.context?.origin;
  const tool = origin !== undefined ? flat(origin.toolCall.title, 60) : request.toolName;
  const what = `${label === undefined ? "" : `${label} `}${tool}`;
  switch (outcome) {
    case "allow":
      return `已允许 ${what}`;
    case "allow_session":
      return `已允许 ${what}（本会话同类不再询问）`;
    case "deny":
      return `已拒绝 ${what}`;
    case "cancelled":
      return `审批已取消（超时或中断）：${what}`;
  }
}
