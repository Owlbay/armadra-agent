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
 * [W6-A] Agent 栏（agent-ui.ts）：栏聚焦时它先收键（Esc 是「返回」，不中断、不回滚）；补全没开、没在浏览
 * 历史时 `app.agents.focus`（缺省 `↓`）先问它要不要进栏，不要就照常交给编辑器（下移、历史下一条）。
 * [W7-A] 落空给一行提示：输入有字（每段草稿一次，光标在末行时）、栏关闭、没有任务。
 */

import { msg } from "../../i18n/index.js";
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
/** [W7-A] 进栏落空提示的停留时间。 */
export const FOCUS_HINT_MS = 3000;

/**
 * [W7-A] 进栏键的结果：true 已进栏；false 不管（交给编辑器，不提示）；其余是落空原因——
 * `busy-input` 输入框有字、`disabled` `ui.agentBar: "off"`（有任务时）、`empty` 没有任务。
 */
export type AgentFocusResult = boolean | "busy-input" | "disabled" | "empty";

/** [W6-A] Agent 栏的按键入口。 */
export interface AgentKeys {
  /** 栏聚焦时先消费按键；返回 true 已处理。 */
  handleKey(data: string): boolean;
  /** `app.agents.focus`：输入为空且有任务时进栏返回 true，否则返回落空原因（按键仍交给编辑器）。 */
  focus(data: string): AgentFocusResult;
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
  /** [W7-A] 提示里的 `↓` 字形（ASCII 主题 `v`；缺省 `↓`）。 */
  downGlyph?: string;
}

/** 返回输入监听器：已处理返回 true，交给编辑器返回 false。 */
export function createKeyDispatch(deps: KeyDispatchDeps): (data: string) => boolean {
  const { keys, editor, tools, status } = deps;
  let ctrlCArmedAt = Number.NEGATIVE_INFINITY;
  const esc = new DoubleEscape(deps.doubleEscMs);
  /** 本段草稿已给过「输入框有字」提示（输入清空后重置）。 */
  let busyInputHinted = false;
  /** 底部正显示着进栏落空提示（进栏后撤掉）。 */
  let focusHintShown = false;

  const doubleEscape = (): void => {
    switch (esc.press(deps.now(), editor.isEmpty())) {
      case "arm-rewind":
        deps.showHint(msg().interactive.keys.escRewind, DOUBLE_ESC_HINT_MS);
        return;
      case "arm-clear":
        deps.showHint(msg().interactive.keys.escClear, DOUBLE_ESC_HINT_MS);
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
        deps.showHint(msg().interactive.keys.cleared);
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
    const label = msg().interactive.commands.modeSet(permissionModeLabel(mode));
    deps.showHint(skipped ? msg().interactive.keys.bypassSkipped(label) : label);
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

  /** 光标在最后一行（`↓` 不再下移，只会到行尾）。 */
  const atLastLine = (): boolean => editor.cursor.line >= editor.getText().split("\n").length - 1;

  /** `app.agents.focus`：进栏返回 true；落空给提示后返回 false（按键照常交给编辑器）。 */
  const focusAgents = (agents: AgentKeys, data: string): boolean => {
    if (editor.isCompletionOpen || editor.isBrowsingHistory) return false;
    const result = agents.focus(data);
    if (result === true) {
      // 进栏了：撤掉之前的落空提示
      if (focusHintShown) deps.showHint("");
      focusHintShown = false;
      return true;
    }
    const m = msg().agents;
    let text: string | undefined;
    if (result === "busy-input") {
      if (busyInputHinted || !atLastLine()) return false;
      busyInputHinted = true;
      text = m.focus.busyInput(deps.downGlyph ?? "↓");
    } else if (result === "disabled") text = m.focus.disabled;
    else if (result === "empty") text = m.bar.empty;
    if (text !== undefined) {
      deps.showHint(text, FOCUS_HINT_MS);
      focusHintShown = true;
    }
    return false;
  };

  return (data) => {
    if (deps.inactive()) return false;
    if (editor.isEmpty()) busyInputHinted = false;
    const is = (action: Parameters<Keybindings["matches"]>[1]): boolean =>
      keys.matches(data, action);
    if (!is("app.rewind")) esc.reset();
    const agents = deps.agents?.();
    if (agents?.handleKey(data) === true) {
      esc.reset();
      return true;
    }
    if (agents !== undefined && is("app.agents.focus") && focusAgents(agents, data)) return true;
    if (is("app.clear")) {
      if (!editor.isEmpty()) {
        editor.clear();
        ctrlCArmedAt = deps.now();
        deps.showHint(msg().interactive.keys.clearedCtrlC);
      } else if (deps.now() - ctrlCArmedAt < DOUBLE_CTRL_C_MS) {
        deps.exit(ExitCode.Sigint);
      } else {
        ctrlCArmedAt = deps.now();
        deps.showHint(msg().interactive.keys.ctrlCAgain);
      }
      return true;
    }
    ctrlCArmedAt = Number.NEGATIVE_INFINITY;
    if (is("app.interrupt") && !editor.isCompletionOpen && deps.busy()) {
      esc.reset();
      interrupt();
      deps.showHint(msg().interactive.keys.interrupted);
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
      deps.showHint(
        expanded ? msg().interactive.keys.toolsExpanded : msg().interactive.keys.toolsCollapsed,
      );
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
