/**
 * 交互界面的审批接线，从 interactive-mode.ts 拆出（保持装配文件 ≤ 600 行）。[W7-C]
 *
 * broker 由外到内：首次运行合并（approval-merge.ts）→ 后台任务停靠（approval-dock.ts）→ 底部对话框
 * （approval-dialog.ts）。对话框打开 / 关闭时禁用编辑器提交、标记运行中的工具「等待确认」、运行提示行换
 * 「等待确认」。
 */

import { taskRegistryView } from "../../agent/subagent-registry.js";
import type { AgentSession } from "../../agent/types.js";
import { msg } from "../../i18n/index.js";
import type { ApprovalBroker } from "../../permissions/types.js";
import type { Component, Editor, Keybindings, OverlayHandle, TUI, Theme } from "../../tui.js";
import type { AgentUi } from "./agent-ui.js";
import { ApprovalDialogBroker, approvalOutcomeText } from "./approval-dialog.js";
import { ApprovalDock } from "./approval-dock.js";
import { mergingBroker } from "./approval-merge.js";
import type { NoticeLevel } from "./message-view.js";
import type { RunIndicator } from "./run-indicator.js";
import type { ToolTracker } from "./tool-view.js";

export interface OverlayHooks {
  showOverlay(component: Component): OverlayHandle;
  onOpen(): void;
  onClose(): void;
}

export function approvalOverlayHooks(deps: {
  tui: TUI;
  editor: Editor;
  tools(): ToolTracker;
  indicator: RunIndicator;
}): OverlayHooks {
  const { tui, editor, indicator } = deps;
  return {
    showOverlay: (component) => tui.showOverlay(component, { anchor: "bottom" }),
    onOpen: () => {
      editor.disableSubmit = true;
      deps.tools().setAwaiting(true);
      indicator.setApproval(true);
    },
    onClose: () => {
      editor.disableSubmit = false;
      deps.tools().setAwaiting(false);
      indicator.setApproval(false);
    },
  };
}

export interface ApprovalUiDeps {
  theme: Theme;
  keys: Keybindings;
  tui: TUI;
  editor: Editor;
  indicator: RunIndicator;
  agentUi: AgentUi;
  hooks: OverlayHooks;
  session(): AgentSession;
  notice(level: NoticeLevel, text: string): void;
  render(): void;
}

/** 组装界面 broker，并把停靠接到 Agent 栏与运行提示行。 */
export function createApprovalUi(deps: ApprovalUiDeps): {
  broker: ApprovalBroker;
  dock: ApprovalDock;
} {
  const { theme, keys, tui, editor, indicator, agentUi, hooks, notice } = deps;
  const taskInfo = (taskId: string) =>
    taskRegistryView(deps.session().state.sessionId)?.get(taskId);
  const taskAgent = (taskId: string): string | undefined => taskInfo(taskId)?.agent;
  const dialog = new ApprovalDialogBroker({
    theme,
    keybindings: keys,
    cwd: deps.session().state.cwd,
    permissionMode: () => deps.session().state.permissionMode,
    taskAgent,
    externalRunner: (agent) => agentUi.merge.externalRunner(agent),
    ...hooks,
    report: (request, outcome) => {
      if (outcome === "deny" || outcome === "cancelled") {
        const text = approvalOutcomeText(request, outcome, taskAgent);
        notice(outcome === "deny" ? "info" : "warn", text);
      }
    },
  });
  const dock = new ApprovalDock(dialog, {
    dockable: (taskId) => {
      const info = taskInfo(taskId);
      return info?.status === "running" && info.background === true;
    },
    ready: (taskId) =>
      agentUi.viewing === taskId || (!tui.hasOverlay && !indicator.busy && editor.isEmpty()),
    changed: () => {
      indicator.sync();
      deps.render();
    },
  });
  agentUi.dock = dock;
  indicator.docked = () => dock.size > 0;
  const broker = mergingBroker(dock, agentUi.merge, (request) =>
    notice(
      "info",
      msg().interactive.app.followed(approvalOutcomeText(request, "allow", taskAgent)),
    ),
  );
  return { broker, dock };
}
