/**
 * 交互界面的第五波接线（计划审批、子 Agent、外部 Agent、剪贴板图片、harness 提示），从 interactive-mode.ts
 * 拆出来，保持装配文件在 600 行以内。[W5-U]
 *
 * - 事件：`subagent_start / update / end` → 折叠视图（subagent-view.ts）并刷新对应的 task 工具行，后台任务
 *   结束给一行提示；`limit_reached`、`model_fallback`、`background_job` → 一行友好提示。
 * - 会话：`attach(session)` 接管计划审批（plan-flow.ts）、把外部 Agent 的 notice 转到消息区。
 * - 命令：`/plan`（无参数：面板，有待审批的计划时打开审批框）、`/tasks`（无参数：选择任务，查看输出或停止）、
 *   `/agents`、`/paste`；其余参数形式交给 commands-core（与 line 模式同一语义）。
 * - `Ctrl+V` / `/paste`：剪贴板图片写进数据目录，输入框光标处插入 `@<路径>`。
 *
 * 外部 Agent 的 notice（W5-E runner 的 `{type:"notice"}`）由任务注册表写进会话日志（`[task tN] …`），没有
 * 事件；这里在会话的 `options.log` 外面套一层，只把这类行转到消息区，其余照原样写日志。
 */

import type { AgentSession, SessionEvent } from "../../agent/types.js";
import type { SwitchRequest } from "../../cli/compose-session.js";
import type { ClipboardDeps } from "../../tools/clipboard-image.js";
import { taskRegistryView } from "../../agent/subagent-registry.js";
import { planController } from "../../plan/controller.js";
import type { Component, Editor, TUI, Theme } from "../../tui.js";
import { agentsPanel, planPanel, taskOutputPanel } from "./agent-panels.js";
import { FirstRunMerge } from "./approval-merge.js";
import { pasteImage } from "./clipboard-paste.js";
import { backgroundJobText, limitReachedText, modelFallbackText } from "./event-notices.js";
import { editExternally } from "./external-editor.js";
import type { NoticeLevel } from "./message-view.js";
import type { PickerSpec } from "./pickers.js";
import { PlanFlow } from "./plan-flow.js";
import type { PlanDialogHost } from "./plan-dialog.js";
import { backgroundEndText, SubagentTracker } from "./subagent-view.js";
import { listTasks, stopTask, taskLine, taskOutput } from "./tasks-report.js";
import type { ToolTracker } from "./tool-view.js";

type LogFn = (level: "debug" | "info" | "warn" | "error", message: string) => void;

export interface AgentUiDeps {
  theme: Theme;
  tui: TUI;
  editor: Editor;
  tools(): ToolTracker;
  subagents: SubagentTracker;
  session(): AgentSession;
  dataDir: string;
  env: Readonly<Record<string, string | undefined>>;
  now(): number;
  notice(level: NoticeLevel, text: string): void;
  panel(component: Component): void;
  pick(spec: PickerSpec): Promise<{ value: string } | undefined>;
  hint(text: string): void;
  render(): void;
  switchSession(request: SwitchRequest): Promise<AgentSession>;
  prompt(text: string): void;
  dialog: Omit<PlanDialogHost, "editExternal" | "render">;
  /** 路径显示（缩写家目录）。 */
  displayPath(path: string): string;
  /** 剪贴板读取的注入（测试）。 */
  clipboard?: ClipboardDeps;
}

const TASK_NOTICE = /^\[task (t\d+)\] ([\s\S]*)$/;

export class AgentUi {
  readonly plan: PlanFlow;
  readonly merge: FirstRunMerge;
  private restoreLog: (() => void) | undefined;
  /** 后台子 Agent 运行中：每秒重画跟随行的耗时（主会话空闲时 Loader 不转）。 */
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: AgentUiDeps) {
    this.merge = new FirstRunMerge({ sessionId: () => deps.session().state.sessionId });
    this.plan = new PlanFlow({
      dialog: {
        ...deps.dialog,
        displayPath: (path) => deps.displayPath(path),
        render: () => deps.render(),
        editExternal: (text, kind) =>
          editExternally(text, kind === "plan" ? "plan.md" : "feedback.md", {
            env: deps.env,
            suspend: () => deps.tui.stop(),
            resume: () => {
              deps.tui.start();
              deps.tui.forceFullRedraw();
            },
          }),
      },
      switchSession: (request) => deps.switchSession(request),
      notice: (level, text) => deps.notice(level, text),
      prompt: (text) => deps.prompt(text),
    });
  }

  /** 新会话（启动、/new /resume /fork）：接管计划审批，转发外部 Agent notice。 */
  attach(session: AgentSession): void {
    this.deps.subagents.clear();
    this.stopTicker();
    this.plan.attach(session);
    this.routeNotices(session);
  }

  detach(): void {
    this.restoreLog?.();
    this.restoreLog = undefined;
    this.stopTicker();
  }

  private followBackground(): void {
    const running = this.deps.subagents.running().filter((s) => s.background);
    if (running.length === 0) return this.stopTicker();
    if (this.ticker !== undefined) return;
    this.ticker = setInterval(() => {
      const live = this.deps.subagents.running().filter((s) => s.background);
      if (live.length === 0) return this.stopTicker();
      for (const state of live) this.deps.tools().get(state.parentToolCallId)?.refresh();
      this.deps.render();
    }, 1000);
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private routeNotices(session: AgentSession): void {
    this.detach();
    const holder = (session as unknown as { options?: { log?: LogFn } }).options;
    if (holder === undefined) return;
    const original = holder.log;
    const routed: LogFn = (level, message) => {
      const match = TASK_NOTICE.exec(message);
      if (match !== null && (level === "info" || level === "warn")) {
        const taskId = match[1] as string;
        const agent = taskRegistryView(session.state.sessionId)?.get(taskId)?.agent ?? "task";
        this.deps.notice(level === "warn" ? "warn" : "info", `[${agent} · ${taskId}] ${match[2]}`);
        return;
      }
      original?.call(holder, level, message);
    };
    holder.log = routed;
    this.restoreLog = () => {
      if (holder.log !== routed) return;
      if (original === undefined) delete holder.log;
      else holder.log = original;
    };
  }

  /** 返回 true：事件已处理（调用方只需重画）。 */
  onEvent(event: SessionEvent): boolean {
    switch (event.type) {
      case "subagent_start":
      case "subagent_update":
      case "subagent_end": {
        const state = this.deps.subagents.onEvent(event);
        if (state === undefined) return true;
        this.deps.tools().get(state.parentToolCallId)?.refresh();
        // 后台任务：完成时 <task-notification> 那一行就是提示；失败 / 停止另给一行
        if (event.type === "subagent_end" && state.background && state.status !== "completed")
          this.deps.notice("warn", backgroundEndText(state));
        this.followBackground();
        return true;
      }
      case "limit_reached":
        this.deps.notice("warn", limitReachedText(event));
        return true;
      case "model_fallback":
        this.deps.notice("warn", modelFallbackText(event));
        return false;
      case "background_job":
        this.deps.notice("info", backgroundJobText(event));
        return true;
      default:
        return false;
    }
  }

  /** 交互界面自己处理的第五波命令；不是返回 false。 */
  async command(name: string, args: string): Promise<boolean> {
    if (args !== "") return false;
    switch (name) {
      case "plan":
        await this.showPlan();
        return true;
      case "tasks":
        await this.tasks();
        return true;
      case "agents":
        this.deps.panel(agentsPanel(this.deps.session().state.sessionId, this.deps.theme));
        return true;
      case "paste":
        await this.paste();
        return true;
      default:
        return false;
    }
  }

  private async showPlan(): Promise<void> {
    const session = this.deps.session();
    const controller = planController(session);
    if (controller === undefined) {
      this.deps.notice("info", "当前会话没有 Plan 能力");
      return;
    }
    this.deps.panel(planPanel(controller, session, this.deps.theme, this.deps.displayPath));
    const pending = controller.pending();
    if (pending !== undefined && !session.state.isStreaming) await this.plan.ask(session, pending);
  }

  private async tasks(): Promise<void> {
    const sessionId = this.deps.session().state.sessionId;
    const tasks = listTasks(sessionId);
    if (tasks.length === 0) {
      this.deps.notice("info", "还没有子 Agent 任务");
      return;
    }
    const now = this.deps.now();
    const picked = await this.deps.pick({
      title: "子 Agent 任务",
      items: [...tasks]
        .reverse()
        .map((task) => ({ value: task.taskId, label: taskLine(task, now) })),
      footer: "↑↓ 选择 · Enter 查看 · Esc 取消",
    });
    if (picked === undefined) return;
    const task = taskRegistryView(sessionId)?.get(picked.value);
    if (task === undefined) return;
    if (task.status === "running") {
      const action = await this.deps.pick({
        title: `任务 ${task.taskId}`,
        items: [
          { value: "output", label: "查看已有输出" },
          { value: "stop", label: "停止任务" },
        ],
        numberKeys: true,
      });
      if (action === undefined) return;
      if (action.value === "stop") {
        await stopTask(sessionId, task.taskId);
        this.deps.notice("info", `已停止 ${task.taskId}`);
        return;
      }
    }
    const fresh = taskRegistryView(sessionId)?.get(task.taskId) ?? task;
    const output = taskOutput(sessionId, task.taskId);
    const { theme, displayPath } = this.deps;
    this.deps.panel(taskOutputPanel(fresh, output, theme, this.deps.now(), displayPath));
  }

  /** `Ctrl+V` / `/paste`：光标处插入 `@<路径>`。 */
  async paste(): Promise<void> {
    this.deps.hint("读取剪贴板…");
    const pasted = await pasteImage(this.deps.dataDir, this.deps.clipboard);
    if (!pasted.ok) {
      this.deps.hint("");
      this.deps.notice("info", pasted.message);
      return;
    }
    const editor = this.deps.editor;
    const before = editor.getText();
    const lead = before === "" || /\s$/.test(before) ? "" : " ";
    editor.insertText(`${lead}${pasted.ref} `);
    this.deps.hint("已插入剪贴板图片");
    this.deps.render();
  }
}
