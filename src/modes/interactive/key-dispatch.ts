/**
 * 交互模式的应用级键位分派（设计 §12）。[B7]
 *
 * 编辑器之前的输入监听：Ctrl+C 清空输入 / 再按退出、Esc 中断（clearQueue 回填编辑器后 abort）、
 * Ctrl+D 空输入退出、Alt+Enter followUp、Alt+↑ 取回最后一条排队消息、Shift+Tab 循环权限模式、
 * Ctrl+O 展开工具输出、Ctrl+L 模型、Ctrl+T 思考级别。键位由 `keybindings.json` 覆盖。
 */

import type { AgentSession } from "../../agent/types.js";
import { ExitCode } from "../../cli/exit-codes.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../../permissions/types.js";
import type { Editor, Keybindings } from "../../tui.js";
import type { StatusBar } from "./status-bar.js";
import type { ToolTracker } from "./tool-view.js";

const DOUBLE_CTRL_C_MS = 1500;

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
  showHint(text: string): void;
  submit(text: string, via: "followUp"): void;
  runCommand(line: string): void;
  exit(code: number): void;
}

/** 返回输入监听器：已处理返回 true，交给编辑器返回 false。 */
export function createKeyDispatch(deps: KeyDispatchDeps): (data: string) => boolean {
  const { keys, editor, tools, status } = deps;
  let ctrlCArmedAt = Number.NEGATIVE_INFINITY;

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

  const cyclePermission = (): void => {
    const session = deps.session();
    const modes = PERMISSION_MODES_STRICT_FIRST;
    const index = modes.indexOf(session.state.permissionMode);
    const next = modes[(index + 1) % modes.length]!;
    session.setPermissionMode(next);
    status.refresh();
    deps.showHint(`权限模式：${next}`);
  };

  return (data) => {
    if (deps.inactive()) return false;
    const is = (action: Parameters<Keybindings["matches"]>[1]): boolean =>
      keys.matches(data, action);
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
      interrupt();
      deps.showHint("已中断");
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
    if (is("app.permission.cycle")) {
      cyclePermission();
      return true;
    }
    if (is("app.tools.expand")) {
      const expanded = tools.toggleExpanded();
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
    return false;
  };
}
