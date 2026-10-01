/**
 * 审批对话框（设计 §12.6）：模式层的 UI `ApprovalBroker`，底部覆盖层。[B7]
 *
 * - 标题行：`[task]`（`request.context.depth > 0`，子 Agent 发起）+ 工具名 + 原因标签；
 * - 输入：bash 显示命令全文，write 显示路径与行数，edit 显示路径与每处修改的 −/+ 摘要，其它显示
 *   一行摘要；`v` 展开 / 收起完整输入（JSON）；
 * - 原因：mode（当前权限模式需要确认）/ dangerous / hook + Hook 给的文本；
 * - 按键：`y` 允许、`n` / Esc / Ctrl+C 拒绝、`a` 本会话允许同类；
 * - 超时与中断：broker 链在超时（缺省 10 分钟）或运行被中断时 abort `signal`，对话框关闭并返回
 *   undefined（链按 deny 处理），消息区留一行说明。
 *
 * broker 链本身串行化审批，所以同一时刻最多一个对话框。
 */

import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "../../permissions/types.js";
import {
  Box,
  Container,
  Text,
  defaultKeybindings,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type Keybindings,
  type OverlayHandle,
  type Theme,
} from "../../tui.js";
import { toolSummary } from "./tool-view.js";

const COMMAND_LINES = 8;
const EDIT_LINES = 3;
const FULL_INPUT_LINES = 40;

export interface ApprovalHost {
  theme: Theme;
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

/** 对话框正文（不含按键行）。 */
export function describeRequest(
  request: ApprovalRequest,
  theme: Theme,
  options: { cwd?: string; permissionMode?: string; expanded?: boolean } = {},
): string[] {
  const out: string[] = [];
  const task = (request.context?.depth ?? 0) > 0 ? theme.fg("warning", "[task] ") : "";
  const tag =
    request.reason === "dangerous"
      ? theme.fg("error", "危险命令")
      : request.reason === "hook"
        ? theme.fg("warning", "Hook 要求确认")
        : theme.fg("dim", "需要确认");
  out.push(`${task}${theme.bold(theme.fg("tool", request.toolName))}  ${tag}`);
  const input = record(request.input);
  const more = (n: number): string => theme.fg("dim", `… 另 ${n} 行（v 查看）`);
  if (options.expanded === true) {
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
  }
  if (request.reason === "hook") {
    out.push(theme.fg("warning", `Hook：${request.hookReason ?? "（无说明）"}`));
  } else if (request.reason === "dangerous") {
    out.push(theme.fg("error", "这条命令可能有破坏性，请确认"));
  } else if (options.permissionMode !== undefined) {
    out.push(theme.fg("dim", `权限模式 ${options.permissionMode} 下需要确认`));
  }
  return out;
}

export const APPROVAL_KEYS_HINT = "[y] 允许  [n] 拒绝  [a] 本会话允许同类  [v] 完整输入";

class ApprovalDialog implements Component, Focusable {
  focused = false;
  private expanded = false;
  private readonly body = new Container();

  constructor(
    private readonly request: ApprovalRequest,
    private readonly host: ApprovalHost,
    private readonly decide: (decision: ApprovalDecision) => void,
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    const { theme } = this.host;
    this.body.clear();
    const options: { cwd?: string; permissionMode?: string; expanded?: boolean } = {
      permissionMode: this.host.permissionMode(),
      expanded: this.expanded,
    };
    if (this.host.cwd !== undefined) options.cwd = this.host.cwd;
    this.body.addChild(new Text(describeRequest(this.request, theme, options).join("\n")));
    this.body.addChild(new Text(theme.fg("accent", APPROVAL_KEYS_HINT)));
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
    } else if (key === "v") {
      this.expanded = !this.expanded;
      this.rebuild();
    }
  }

  render(width: number): string[] {
    return this.body.render(width).map((l) => truncateToWidth(l, width));
  }

  invalidate(): void {
    this.body.invalidate();
  }
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
      handle = this.host.showOverlay(
        new Box(dialog, {
          title: (request.context?.depth ?? 0) > 0 ? "子任务审批" : "审批",
          theme: this.host.theme,
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
): string {
  const task = (request.context?.depth ?? 0) > 0 ? "[task] " : "";
  const what = `${task}${request.toolName}`;
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
