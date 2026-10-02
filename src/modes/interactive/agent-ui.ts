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
 *
 * [W6-A] Agent 栏（agent-bar.ts，提示行之下、状态行之上）与子 Agent 视图（agent-view.ts，底部覆盖层）：
 * - 键位：空输入时 `Ctrl+B`（有任务即可）或 `↓`（栏可见时）进栏（`app.agents.focus`，key-dispatch.ts 先问这里）；
 *   栏内 ↑↓ 选、Enter 打开视图、Esc / Ctrl+B 返回，可打印字符回到输入框；
 * - `/tasks` 无参 = 聚焦栏（`ui.agentBar: "off"` 时仍是原来的选择器），`/tasks <id>` = 直接进视图；
 * - 等审批的任务按 `permission_request.context.taskId` 记下（栏与视图标题显示「等待审批」）。
 */

import type { AgentSession, SessionEvent } from "../../agent/types.js";
import type { SwitchRequest } from "../../cli/compose-session.js";
import type { ClipboardDeps } from "../../tools/clipboard-image.js";
import { registryOf, taskRegistryView } from "../../agent/subagent-registry.js";
import { planController } from "../../plan/controller.js";
import { msg } from "../../i18n/index.js";
import {
  defaultKeybindings,
  isPrintableText,
  parseKey,
  type Keybindings,
  type Component,
  type Editor,
  type OverlayHandle,
  type TUI,
  type Theme,
} from "../../tui.js";
import { AgentBar } from "./agent-bar.js";
import { AgentView } from "./agent-view.js";
import type { CommandUi } from "./commands.js";
import type { AgentKeys } from "./key-dispatch.js";
import type { StatusArea } from "./status-area.js";
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
  /** [W6-A] 底部区域：Agent 栏插在速率行 / 状态栏之上；`ui.*` 配置。 */
  area?: Pick<StatusArea, "rate" | "ui">;
}

/** [W6-A] `CommandUi` 的 Agent 栏 / 视图钩子（`/tasks`、`/tasks <id>`）；晚绑定，装配时 agentUi 还没建。 */
export function agentCommandHooks(get: () => AgentUi): Pick<CommandUi, "agentBar" | "agentView"> {
  return {
    agentBar: () => get().focusBar(),
    agentView: (taskId) => get().openView(taskId),
  };
}

const TASK_NOTICE = /^\[task (t\d+)\] ([\s\S]*)$/;

export class AgentUi {
  readonly plan: PlanFlow;
  readonly merge: FirstRunMerge;
  /** [W6-A] Agent 栏。 */
  readonly bar: AgentBar;
  /** [W6-A] key-dispatch.ts 的 Agent 栏入口。 */
  readonly keys: AgentKeys = {
    handleKey: (data) => this.barKey(data),
    focus: (data) => this.focusFromKey(data),
  };
  private view: { component: AgentView; handle: OverlayHandle } | undefined;
  /** 等审批的请求 → 任务。 */
  private readonly approvals = new Map<string, string>();
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
    this.bar = new AgentBar({
      theme: deps.theme,
      registry: () => registryOf(deps.session().state.sessionId),
      tracker: deps.subagents,
      now: () => deps.now(),
      approvals: () => this.waiting(),
      enabled: () => this.barEnabled(),
    });
    if (deps.area !== undefined) deps.tui.insertBefore(this.bar, deps.area.rate);
  }

  private keybindings(): Keybindings {
    return this.deps.dialog.keybindings ?? defaultKeybindings;
  }

  private barEnabled(): boolean {
    return this.deps.area !== undefined && this.deps.area.ui().agentBar !== "off";
  }

  private waiting(): ReadonlySet<string> {
    return new Set(this.approvals.values());
  }

  /** 新会话（启动、/new /resume /fork）：接管计划审批，转发外部 Agent notice。 */
  attach(session: AgentSession): void {
    const viewing = this.viewing;
    this.closeView();
    // 换了会话：原来在看的任务不在新会话里
    if (viewing !== undefined) this.deps.notice("info", msg().agents.view.removed(viewing));
    this.bar.reset();
    this.approvals.clear();
    this.deps.subagents.clear();
    this.stopTicker();
    this.plan.attach(session);
    this.routeNotices(session);
  }

  detach(): void {
    this.closeView();
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
      this.view?.component.tick();
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
        // 视图里看的任务又开跑（续聊、被释放后重开）：重新接上它的子会话
        if (event.type === "subagent_start" && this.view?.component.task === event.taskId)
          this.view.component.attach();
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
      case "permission_request": {
        const taskId = event.context?.taskId;
        if (taskId !== undefined) this.approvals.set(event.requestId, taskId);
        return false;
      }
      case "permission_resolved":
        this.approvals.delete(event.requestId);
        return false;
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
      this.deps.notice("info", msg().plan.command.unavailable);
      return;
    }
    this.deps.panel(planPanel(controller, session, this.deps.theme, this.deps.displayPath));
    const pending = controller.pending();
    if (pending !== undefined && !session.state.isStreaming) await this.plan.ask(session, pending);
  }

  // -------------------------------------------------------------------------
  // [W6-A] Agent 栏与子 Agent 视图
  // -------------------------------------------------------------------------

  /** `/tasks`（无参）：聚焦 Agent 栏；栏关闭（嵌入宿主缺省）时仍是选择器。 */
  async focusBar(): Promise<void> {
    if (!this.barEnabled()) return this.tasks();
    if (!this.bar.focus()) {
      this.deps.notice("info", msg().agents.bar.empty);
      return;
    }
    this.deps.render();
  }

  /** `app.agents.focus`（输入为空）：`↓` 只在栏可见时进入，其它键（`Ctrl+B`）有任务即可。 */
  private focusFromKey(data: string): boolean {
    if (this.view !== undefined || !this.barEnabled()) return false;
    if (parseKey(data)?.id === "down" && !this.bar.visible) return false;
    if (!this.bar.focus()) return false;
    this.deps.render();
    return true;
  }

  /** 栏聚焦时的按键；不在栏里返回 false。 */
  private barKey(data: string): boolean {
    if (!this.bar.focused) return false;
    const keys = this.keybindings();
    if (keys.matches(data, "tui.select.up")) {
      if (!this.bar.move(-1)) this.bar.blur();
    } else if (keys.matches(data, "tui.select.down")) this.bar.move(1);
    else if (keys.matches(data, "tui.editor.submit")) {
      const taskId = this.bar.selected();
      if (taskId !== undefined) this.openView(taskId);
    } else if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "app.agents.focus"))
      this.bar.blur();
    else {
      // 可打印字符与其它键：退出栏，交给输入框
      this.bar.blur();
      this.deps.render();
      return !isPrintableText(data) && keys.actionsFor(data).length === 0;
    }
    this.deps.render();
    return true;
  }

  /** `/tasks <id>` 与栏里 Enter：打开子 Agent 视图。 */
  openView(taskId: string): void {
    const sessionId = this.deps.session().state.sessionId;
    if (taskRegistryView(sessionId)?.get(taskId) === undefined) {
      this.deps.notice("info", msg().agents.view.unknown(taskId));
      return;
    }
    this.closeView();
    const ui = this.deps.area?.ui() ?? {};
    const component = new AgentView(taskId, {
      theme: this.deps.theme,
      keys: this.keybindings(),
      registry: () => registryOf(this.deps.session().state.sessionId),
      tracker: this.deps.subagents,
      approvals: () => this.waiting(),
      now: () => this.deps.now(),
      rows: () => this.deps.tui.terminal.rows,
      render: () => this.deps.render(),
      siblings: () => this.bar.all().map((row) => row.taskId),
      close: () => this.closeView(),
      stop: (id) => stopTask(this.deps.session().state.sessionId, id),
      messages: {
        ...(ui.showThinking !== undefined ? { showThinking: ui.showThinking } : {}),
        ...(ui.markdown !== undefined ? { markdown: ui.markdown } : {}),
        ...(ui.compact === true ? { compact: true } : {}),
      },
    });
    // 视图盖住主区时主区不变（栏收起）；Esc 回到主界面
    this.bar.blur();
    const handle = this.deps.tui.showOverlay(component, { anchor: "bottom" });
    this.view = { component, handle };
    this.deps.render();
  }

  get viewing(): string | undefined {
    return this.view?.component.task;
  }

  /** 撤掉视图（Esc、换会话、退出）；看到了结束后的状态就算查看过。 */
  closeView(): void {
    const view = this.view;
    if (view === undefined) return;
    this.view = undefined;
    view.component.dispose();
    view.handle.hide();
    const taskId = view.component.task;
    const info = taskRegistryView(this.deps.session().state.sessionId)?.get(taskId);
    if (info !== undefined && info.status !== "running") this.bar.markViewed(taskId);
    this.bar.blur();
    this.deps.render();
  }

  private async tasks(): Promise<void> {
    const sessionId = this.deps.session().state.sessionId;
    const tasks = listTasks(sessionId);
    if (tasks.length === 0) {
      this.deps.notice("info", msg().panels.tasks.none);
      return;
    }
    const now = this.deps.now();
    const picked = await this.deps.pick({
      title: msg().interactive.agentUi.tasksTitle,
      items: [...tasks]
        .reverse()
        .map((task) => ({ value: task.taskId, label: taskLine(task, now) })),
      footer: msg().interactive.agentUi.tasksFooter("↑↓"),
    });
    if (picked === undefined) return;
    const task = taskRegistryView(sessionId)?.get(picked.value);
    if (task === undefined) return;
    if (task.status === "running") {
      const action = await this.deps.pick({
        title: msg().panels.tasks.title(task.taskId),
        items: [
          { value: "output", label: msg().interactive.agentUi.viewOutput },
          { value: "stop", label: msg().interactive.agentUi.stop },
        ],
        numberKeys: true,
      });
      if (action === undefined) return;
      if (action.value === "stop") {
        await stopTask(sessionId, task.taskId);
        this.deps.notice("info", msg().interactive.agentUi.stopped(task.taskId));
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
    this.deps.hint(msg().interactive.clipboard.reading);
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
    this.deps.hint(msg().interactive.clipboard.inserted);
    this.deps.render();
  }
}
