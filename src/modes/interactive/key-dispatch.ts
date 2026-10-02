/**
 * 交互模式的应用级键位分派（设计 §12）。[B7]
 *
 * 编辑器之前的输入监听：Ctrl+C 清空输入 / 再按退出、Esc 中断（clearQueue 回填编辑器后 abort）、
 * Ctrl+D 空输入退出、Alt+Enter followUp、Alt+↑ 取回最后一条排队消息、Shift+Tab 循环权限模式、
 * Ctrl+O 展开工具输出与思考块、Ctrl+L 模型、Ctrl+T 思考级别、Ctrl+G 底部信息行 full ↔ compact（W5-A）、
 * Ctrl+V 粘贴剪贴板图片（`app.paste.image`，W5-U）。
 * 键位由 `keybindings.json` 覆盖。
 *
 * [RW-C] 空闲时双击 Esc（`app.rewind`，double-esc.ts）：输入框为空打开回滚列表，有字则清空并存进
 * 输入历史；运行中 Esc 仍为中断，中断后交给 `onInterrupted`（中断即撤回）。
 *
 * [W6-A] Agent 栏（agent-ui.ts）：栏聚焦时它先收键（Esc 是「返回」，不中断、不回滚）；输入为空、补全没开时
 * `app.agents.focus`（缺省 `Ctrl+B` / `↓`）先问它要不要进栏，不要就照常交给编辑器（光标左移、历史下一条）。
 */

import type { AgentSession } from "../../agent/types.js";
import { ExitCode } from "../../cli/exit-codes.js";
import { nextCycleMode, permissionModeLabel } from "../../permissions/modes.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { Editor, Keybindings } from "../../tui.js";
import { DOUBLE_ESC_HINT_MS, DoubleEscape } from "./double-esc.js";
import { statusLineText } from "./status-area.js";
import type { StatusBar } from "./status-bar.js";
import type { ToolTracker } from "./tool-view.js";

const DOUBLE_CTRL_C_MS = 1500;

/** [W6-A] Agent 栏的按键入口。 */
export interface AgentKeys {
  /** 栏聚焦时先消费按键；返回 true 已处理。 */
  handleKey(data: string): boolean;
  /** `app.agents.focus`（输入为空）：进栏返回 true，否则交给编辑器。 */
  focus(data: string): boolean;
}

export interface KeyDispatchDeps {
  keys: Keybindings;
  editor: Editor;
  tools: ToolTracker;
  status: StatusBar;
  session(): AgentSession;
  /** 已退出或有覆盖层（审批 / 选择器）时不处理。 */
  inactive(): boolean;
  /** 运行或压缩中（Esc 才中断）。 */
  busy(): boolean;
  now(): number;
  /** 底部提示；`ms` 是停留时间（缺省由调用方决定）。 */
  showHint(text: string, ms?: number): void;
  /** Ctrl+O 之后（消息区思考块跟着展开 / 折叠）。 */
  onExpandToggle?(expanded: boolean): void;
  /** Ctrl+G：切换底部信息行，返回切换后的布局。 */
  onStatusLineToggle?(): "full" | "compact";
  /**
   * 循环到某模式前的确认（进入 Bypass 前弹确认框，permissions/bypass.ts）；返回 false 时跳过该模式，
   * 落到循环里的下一个。没有时直接切换。
   */
  confirmMode?(mode: PermissionMode): boolean | Promise<boolean>;
  /** Ctrl+V：粘贴剪贴板图片（W5-U）。 */
  onPasteImage?(): void;
  submit(text: string, via: "followUp"): void;
  runCommand(line: string): void;
  exit(code: number): void;
  /** Esc 中断之后（参数：中断后输入框是否为空）。 */
  onInterrupted?(editorWasEmpty: boolean): void;
  /** 双击 Esc 的间隔（测试注入）。 */
  doubleEscMs?: number;
  /** [W6-A] Agent 栏（晚绑定）。 */
  agents?(): AgentKeys | undefined;
}

/** 返回输入监听器：已处理返回 true，交给编辑器返回 false。 */
export function createKeyDispatch(deps: KeyDispatchDeps): (data: string) => boolean {
  const { keys, editor, tools, status } = deps;
  let ctrlCArmedAt = Number.NEGATIVE_INFINITY;
  const esc = new DoubleEscape(deps.doubleEscMs);

  const doubleEscape = (): void => {
    switch (esc.press(deps.now(), editor.isEmpty())) {
      case "arm-rewind":
        deps.showHint("再按 Esc 回滚", DOUBLE_ESC_HINT_MS);
        return;
      case "arm-clear":
        deps.showHint("再按 Esc 清空", DOUBLE_ESC_HINT_MS);
        return;
      case "rewind":
        deps.showHint("");
        deps.runCommand("/rewind");
        return;
      case "clear": {
        // 记进输入历史再清空：↑ 可取回
        const text = editor.getExpandedText();
        if (text.trim() !== "") editor.addToHistory(text);
        editor.clear();
        deps.showHint("已清空输入 · ↑ 取回");
        return;
      }
    }
  };

  const interrupt = (): void => {
    const session = deps.session();
    const queued = session.clearQueue();
    const restore = [...queued.steering, ...queued.followUp];
    if (restore.length > 0) {
      const current = editor.getText();
      editor.setText([...restore, ...(current.trim() !== "" ? [current] : [])].join("\n"));
    }
    void session.abort().catch(() => undefined);
  };

  const dequeue = (): void => {
    const session = deps.session();
    const queued = session.clearQueue();
    const steering = [...queued.steering];
    const followUp = [...queued.followUp];
    const last = followUp.length > 0 ? followUp.pop() : steering.pop();
    if (last === undefined) return;
    for (const text of steering) void session.steer(text).catch(() => undefined);
    for (const text of followUp) void session.followUp(text).catch(() => undefined);
    const current = editor.getText();
    editor.setText(current.trim() === "" ? last : `${last}\n${current}`);
  };

  const applyMode = (mode: PermissionMode, skipped: boolean): void => {
    deps.session().setPermissionMode(mode);
    status.refresh();
    const label = `权限模式：${permissionModeLabel(mode)}`;
    deps.showHint(skipped ? `未进入 Bypass · ${label}` : label);
  };

  const cyclePermission = (): void => {
    const next = nextCycleMode(deps.session().state.permissionMode);
    // 取消进入 Bypass：跳过它继续循环（回到起点 Manual），而不是停在原模式——否则不进 Bypass 就绕不回去
    const settle = (ok: boolean): void =>
      ok ? applyMode(next, false) : applyMode(nextCycleMode(next), true);
    const answer = deps.confirmMode?.(next) ?? true;
    if (typeof answer === "boolean") settle(answer);
    else void answer.then(settle);
  };

  return (data) => {
    if (deps.inactive()) return false;
    const is = (action: Parameters<Keybindings["matches"]>[1]): boolean =>
      keys.matches(data, action);
    if (!is("app.rewind")) esc.reset();
    const agents = deps.agents?.();
    if (agents?.handleKey(data) === true) {
      esc.reset();
      return true;
    }
    if (
      agents !== undefined &&
      is("app.agents.focus") &&
      editor.isEmpty() &&
      !editor.isCompletionOpen &&
      agents.focus(data)
    )
      return true;
    if (is("app.clear")) {
      if (!editor.isEmpty()) {
        editor.clear();
        ctrlCArmedAt = deps.now();
        deps.showHint("已清空输入 · 再按 Ctrl+C 退出");
      } else if (deps.now() - ctrlCArmedAt < DOUBLE_CTRL_C_MS) {
        deps.exit(ExitCode.Sigint);
      } else {
        ctrlCArmedAt = deps.now();
        deps.showHint("再按一次 Ctrl+C 退出");
      }
      return true;
    }
    ctrlCArmedAt = Number.NEGATIVE_INFINITY;
    if (is("app.interrupt") && !editor.isCompletionOpen && deps.busy()) {
      esc.reset();
      interrupt();
      deps.showHint("已中断");
      deps.onInterrupted?.(editor.isEmpty());
      return true;
    }
    if (is("app.rewind") && !editor.isCompletionOpen && !deps.busy()) {
      doubleEscape();
      return true;
    }
    if (is("app.exit") && editor.isEmpty()) {
      deps.exit(ExitCode.Ok);
      return true;
    }
    if (is("app.message.followUp")) {
      const text = editor.takeSubmission();
      if (text !== null) deps.submit(text, "followUp");
      return true;
    }
    if (is("app.message.dequeue")) {
      dequeue();
      return true;
    }
    // 与补全共用的键（缺省 Tab）只在输入为空、补全未打开时切换模式；有输入时照常交给编辑器补全
    if (
      is("app.permission.cycle") &&
      (!is("tui.editor.complete") || (editor.isEmpty() && !editor.isCompletionOpen))
    ) {
      cyclePermission();
      return true;
    }
    if (is("app.tools.expand")) {
      const expanded = tools.toggleExpanded();
      deps.onExpandToggle?.(expanded);
      deps.showHint(expanded ? "工具输出：展开" : "工具输出：折叠");
      return true;
    }
    if (is("app.model.select")) {
      deps.runCommand("/model");
      return true;
    }
    if (is("app.thinking.select")) {
      deps.runCommand("/thinking");
      return true;
    }
    if (is("app.paste.image") && deps.onPasteImage !== undefined) {
      deps.onPasteImage();
      return true;
    }
    if (is("app.statusLine.toggle") && deps.onStatusLineToggle !== undefined) {
      const mode = deps.onStatusLineToggle();
      deps.showHint(statusLineText(mode));
      return true;
    }
    return false;
  };
}
