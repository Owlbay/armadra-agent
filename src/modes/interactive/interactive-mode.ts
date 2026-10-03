/**
 * 交互模式装配（设计 §12、实施计划 §3）。[B7]
 *
 * 布局（主屏模式，自上而下）：消息区（启动画面 + 对话，超出屏幕的部分进终端回滚）→ 空行 →
 * 排队消息 → 运行指示（Loader）→ 编辑器 → 提示行 → 状态栏。审批对话框是底部覆盖层，选择器居中。
 *
 * - 终端：缺省 `ProcessTerminal`；stdin / stdout 不是 TTY 或进入 raw 模式失败 → 抛
 *   `AmaError("terminal_init_failed")`，bootstrap 降级为 line 模式。
 * - 事件：订阅当前会话的 `SessionEvent` 驱动消息区 / 工具视图 / 状态栏；`/new /resume /fork` 之后
 *   重新订阅、重画消息区并 `announceStart`。
 * - 晚绑定：`runtime.approvals.setUiBroker`（审批对话框）与 `runtime.notifier.set`（宿主通知进消息区），
 *   退出时撤下。
 * - 键位：Enter 发送（运行中 = steer），其余应用级键位见 `key-dispatch.ts`。
 * - 回滚（RW-C）：`/rewind` 与空闲双击 Esc 走 rewind-flow.ts；回填的原消息图片暂存，随下一条消息发送。
 * - 底部（W5-A，status-area.ts）：`ui.statusLine` full 时状态栏上方多一行速率行；Ctrl+G / `/statusline`
 *   切换（只影响本会话）。
 * - 第五波（W5-U，agent-ui.ts）：计划审批框、子 Agent 折叠视图、`/tasks` `/agents` `/paste` 与 Ctrl+V、审批来源
 *   标注与外部 Agent 首次运行的合并确认（approval-merge.ts）、harness 提示。
 * - 启动头按 `ui.quietStartup`（startup-header.ts）：normal「AMA」字符画 + 信息列（启动时点亮扫描一次，
 *   startup-logo.ts；窄屏 / `ui.logo: off` / `ui.compact` 不画字符画），header 一行，silent 不输出。
 */

import { promptImages, sessionModel } from "../image-input.js";
import { join } from "node:path";
import { AgentSessionImpl } from "../../agent/session.js";
import { taskRegistryView } from "../../agent/subagent-registry.js";
import type { AgentSession, RewindDraftText, SessionEvent } from "../../agent/types.js";
import type { ImageBlock } from "../../ai/types.js";
import { currentSession, switchSession, type SwitchRequest } from "../../cli/compose-session.js";
import type { ModeContext } from "../../cli/deps.js";
import type { Runtime } from "../../cli/runtime.js";
import { startupInfo, startupScreenLevel, tildePath } from "../../cli/startup-screen.js";
import { AmaError, isAmaError } from "../../errors.js";
import { msg } from "../../i18n/index.js";
import type { StatusLineMode } from "../../config/types.js";
import type { ClipboardDeps } from "../../tools/clipboard-image.js";
import {
  Container,
  Editor,
  Loader,
  Spacer,
  TUI,
  Text,
  createTheme,
  detectCapabilities,
  resolveAscii,
  resolveThemeName,
  type Component,
  type Keybindings,
  type Terminal,
  type Theme,
} from "../../tui.js";
import { BYPASS_MODE, createBypassGate } from "../../permissions/bypass.js";
import { onTerminationSignals } from "../shared.js";
import { AgentUi, agentCommandHooks } from "./agent-ui.js";
import { ApprovalDialogBroker, approvalOutcomeText } from "./approval-dialog.js";
import { mergingBroker } from "./approval-merge.js";
import { ALL_COMMANDS, runInteractiveCommand, type CommandUi } from "./commands.js";
import { memoryPanelFor } from "./memory-panel.js";
import { InteractiveCompletion } from "./completion.js";
import { confirmBypass } from "./confirm-dialog.js";
import { configUiFor } from "./config-ui.js";
import { createKeyDispatch } from "./key-dispatch.js";
import { MessageView, exitSummaryLines, type NoticeLevel } from "./message-view.js";
import { openPicker } from "./pickers.js";
import { modelPickerFor } from "./model-picker.js";
import { createRewindFlow } from "./rewind-flow.js";
import { openTraceView } from "./trace-view.js";
import { StartupHeader } from "./startup-header.js";
import { playStartupAnimation, type LogoAnimation } from "./startup-logo.js";
import { QueueView, RunIndicator } from "./run-indicator.js";
import { StatusArea, statusLineSlash } from "./status-area.js";
import type { StatusBar } from "./status-bar.js";
import { createSessionEventHandler } from "./session-events.js";
import { SubagentTracker } from "./subagent-view.js";
import { loadKeys, processTerminal } from "./terminal-setup.js";
import { ToolTracker } from "./tool-view.js";

const HINT_MS = 2500;

export interface InteractiveModeOptions {
  /** 缺省 `ProcessTerminal`（测试注入 MemoryTerminal）。 */
  terminal?: Terminal;
  theme?: Theme;
  keybindings?: Keybindings;
  /** Loader 计时与相对时间（测试注入）。 */
  now?: () => number;
  /** Loader 帧间隔；测试设很大让帧固定。 */
  spinnerIntervalMs?: number;
  /** 输入历史文件；false 不读写（缺省 `<dataDir>/history`）。 */
  historyFile?: string | false;
  /** 底部布局（缺省按 `ui.statusLine`；测试固定）。 */
  statusLine?: StatusLineMode;
  /** 界面就绪后回调（测试驱动用）。 */
  onReady?(handle: InteractiveHandle): void;
  /** 剪贴板读取的注入（测试；缺省调系统命令）。 */
  clipboard?: ClipboardDeps;
}

export interface InteractiveHandle {
  readonly tui: TUI;
  readonly editor: Editor;
  readonly view: MessageView;
  readonly tools: ToolTracker;
  readonly status: StatusBar;
  readonly area: StatusArea;
  session(): AgentSession;
  exit(code: number): void;
}

export function runInteractiveMode(
  runtime: Runtime,
  context: ModeContext,
  options: InteractiveModeOptions = {},
): Promise<number> {
  const terminal = options.terminal ?? processTerminal();
  const ui = runtime.config.ui ?? {};
  const env = context.io.env as NodeJS.ProcessEnv;
  const theme =
    options.theme ??
    createTheme(resolveThemeName(ui.theme, env), {
      caps: detectCapabilities(env, context.io.stdoutIsTTY),
      ascii: resolveAscii(ui.ascii, env),
    });
  const now = options.now ?? Date.now;
  const startedAt = now();
  const startupWarnings: string[] = [];
  const keys = options.keybindings ?? loadKeys(runtime, (m) => startupWarnings.push(m));

  let session = currentSession(runtime);
  const tui = new TUI(terminal);
  const view = new MessageView({
    theme,
    ...(ui.showThinking !== undefined ? { showThinking: ui.showThinking } : {}),
    ...(ui.markdown !== undefined ? { markdown: ui.markdown } : {}),
    ...(ui.compact === true ? { compact: true } : {}),
  });
  const subagents = new SubagentTracker(now);
  const tools = new ToolTracker({
    theme,
    cwd: session.state.cwd,
    getTool: (name) => session.getTools().find((tool) => tool.name === name),
    now,
    spinner: () => loader.frame,
    subagent: (toolCallId) => subagents.forToolCall(toolCallId),
  });
  const queueView = new QueueView(theme);
  const loaderSlot = new Container();
  const loader = new Loader(() => tui.requestRender(), {
    theme,
    message: msg().interactive.view.run.thinking,
    now,
    ...(ui.animation === false ? { animation: false } : {}),
    ...(options.spinnerIntervalMs !== undefined ? { intervalMs: options.spinnerIntervalMs } : {}),
  });
  loader.onFrame(() => tools.tick());
  const area = new StatusArea({
    runtime,
    theme,
    session: () => session,
    now,
    render: () => tui.requestRender(),
    redraw: () => tui.forceFullRedraw(),
    env,
    ...(options.statusLine !== undefined ? { layout: options.statusLine } : {}),
  });
  const { hint, bar: status } = area;
  const historyFile =
    options.historyFile === false
      ? undefined
      : (options.historyFile ?? join(runtime.paths.dataDir, "history"));
  const completion = new InteractiveCompletion({
    commands: () => ALL_COMMANDS,
    prompts: () => runtime.resources.prompts,
    skills: () => runtime.resources.skills,
    cwd: () => session.state.cwd,
    now,
  });
  const editor = new Editor({
    theme,
    keybindings: keys,
    maxVisibleLines: 8,
    placeholder: msg().interactive.app.placeholder,
    autocomplete: completion,
    requestRender: () => tui.requestRender(),
    ...(historyFile !== undefined ? { historyFile } : {}),
    onSubmit: (text) => submit(text, "enter"),
  });

  tui.addChild(view);
  tui.addChild(new Spacer());
  tui.addChild(queueView);
  tui.addChild(loaderSlot);
  tui.addChild(editor);
  tui.addChild(hint);
  tui.addChild(area.rate);
  tui.addChild(status);

  // ---- 小工具 ---------------------------------------------------------------

  let finished = false;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExit: (code: number) => void = () => undefined;

  const render = (): void => tui.requestRender();
  const notice = (level: NoticeLevel, text: string): void => {
    view.addNotice(level, text);
    render();
  };
  const showHint = (text: string, ms = HINT_MS): void => {
    hint.setText(text === "" ? "" : theme.fg("dim", text));
    if (hintTimer !== undefined) clearTimeout(hintTimer);
    hintTimer = undefined;
    if (text !== "") {
      hintTimer = setTimeout(() => {
        hint.setText("");
        render();
      }, ms);
      hintTimer.unref?.();
    }
    render();
  };
  const indicator = new RunIndicator({ theme, loader, slot: loaderSlot, tools, render });
  const setQueue = (steering: readonly string[], followUp: readonly string[]): void => {
    status.setQueue(steering.length, followUp.length);
    queueView.setQueue(steering, followUp);
    render();
  };

  // ---- 会话事件 -------------------------------------------------------------

  const onEvent = createSessionEventHandler({
    view,
    tools,
    status,
    area,
    agentUi: () => agentUi,
    indicator,
    session: () => session,
    setQueue,
    notice,
    render,
  });
  let unsubscribe = session.subscribe(onEvent);

  const startupLevel = startupScreenLevel(runtime);
  const home = env["HOME"] ?? env["USERPROFILE"];
  const info = startupInfo(runtime, home);
  const header = (level: "normal" | "header"): StartupHeader =>
    new StartupHeader(info, { theme, level, logo: ui.logo, compact: ui.compact });
  /** 清空消息区（切换会话、/tree）：只留一行头。 */
  const resetView = (): void => {
    view.reset();
    if (startupLevel !== "silent") view.add(header("header"));
  };

  const replay = (): void => {
    view.replay(session.messages, {
      tool: (call, result) =>
        tools.completed(
          call.id,
          call.name,
          call.arguments,
          result === undefined
            ? { content: msg().interactive.app.noResult, isError: true }
            : {
                content: result.content,
                isError: result.isError,
                ...(result.details !== undefined ? { details: result.details } : {}),
              },
          result?.isError ?? true,
        ),
    });
  };

  const rebind = (next: AgentSession, reason: "new" | "resume" | "fork"): void => {
    unsubscribe();
    session = next;
    unsubscribe = next.subscribe(onEvent);
    resetView();
    tools.clear();
    replay();
    setQueue([], []);
    area.rebind();
    agentUi.attach(next);
    indicator.reset();
    if (next instanceof AgentSessionImpl) next.announceStart(reason);
  };

  // ---- 提交与命令 -----------------------------------------------------------

  /**
   * 空闲时发提示。agent_settled 之后会话周期还要一个微任务才结束，所以先 waitForIdle；
   * 仍然撞上运行中（极少）就排到本轮之后。
   */
  let draftImages: ImageBlock[] = [];
  const resize = runtime.config.images?.resize;
  const imageResize = resize !== undefined ? { resize } : {};
  const startPrompt = (text: string): void => {
    const target = session;
    const carried = draftImages;
    draftImages = [];
    void target
      .waitForIdle()
      .then(async () => {
        const images = [
          ...carried,
          ...(await promptImages(
            text,
            [],
            target.state.cwd,
            sessionModel(runtime.providers, target),
            imageResize,
          )),
        ];
        return target.prompt(text, images.length > 0 ? { images } : {});
      })
      .catch((error: unknown) => {
        if (isAmaError(error) && error.code === "busy") {
          void target.followUp(text).catch(() => undefined);
          return;
        }
        if (isAmaError(error) && error.code === "prompt_blocked")
          view.addHookBlocked(error.message);
        else notice("error", error instanceof Error ? error.message : String(error));
        render();
      });
  };

  /** 对话换了路径（/tree、回滚）：重画消息区。内容可能缩到视口顶以上，差分画不对，整屏重画。 */
  const reloadView = (): void => {
    resetView();
    tools.clear();
    replay();
    status.refresh();
    area.refreshGit();
    tui.forceFullRedraw();
  };
  const setDraft = (draft: RewindDraftText): void => {
    editor.setText(draft.text);
    draftImages = [...(draft.images ?? [])];
    render();
  };
  const pickerHost = {
    theme,
    keybindings: keys,
    showOverlay: (c: Component, o: Parameters<TUI["showOverlay"]>[1]) => tui.showOverlay(c, o),
    columns: () => terminal.columns,
    rows: () => terminal.rows,
  };
  // 进入 Bypass 前确认一次；启动时已是 Bypass（命令行 / 配置指定）视为已确认
  const confirmMode = createBypassGate(
    () => confirmBypass(pickerHost),
    session.state.permissionMode === BYPASS_MODE,
  );
  const rewind = createRewindFlow({
    ...pickerHost,
    session: () => session,
    now,
    render,
    notice,
    hint: (text) => showHint(text),
    reload: reloadView,
    setDraft,
    editorEmpty: () => editor.isEmpty(),
  });

  const configUi = configUiFor(pickerHost, { runtime, context, view, loader, area, tui, notice });
  const commandUi: CommandUi = {
    runtime,
    session: () => session,
    async switchSession(request: SwitchRequest) {
      const next = await switchSession(runtime, request);
      rebind(next, request.kind === "new" ? "new" : request.kind === "fork" ? "fork" : "resume");
      return next;
    },
    pick: (spec) => openPicker(pickerHost, spec),
    pickModel: modelPickerFor(pickerHost, runtime, context),
    confirmMode,
    rewind: () => rewind.open(),
    setDraft,
    notice,
    panel: (component) => {
      view.add(component);
      render();
    },
    theme: () => theme,
    env,
    ...(home !== undefined ? { home } : {}),
    setEditorText: (text) => {
      editor.setText(text);
      render();
    },
    prompt: (text) => startPrompt(text),
    reload: reloadView,
    exit: (code) => exit(code),
    now,
    extra: (name, args) => agentUi.command(name, args),
    ...agentCommandHooks(() => agentUi),
    configPanel: (args) => configUi.open(args),
    traceView: (id) =>
      openTraceView({ ...pickerHost, session: () => session, now, notice, render }, id),
    memoryPanel: memoryPanelFor(() => commandUi, pickerHost, tui, env), // [W6-M]
  };

  const runCommand = (line: string): Promise<boolean> =>
    (statusLineSlash(area, line, notice)
      ? Promise.resolve(true)
      : runInteractiveCommand(line, commandUi)
    ).finally(() => {
      status.refresh();
      render();
    });

  function submit(text: string, via: "enter" | "followUp"): void {
    if (text.trim() === "") return;
    if (text.trimStart().startsWith("/")) {
      void runCommand(text.trim()).then((handled) => {
        if (!handled) send(text, via);
      });
      return;
    }
    send(text, via);
  }

  function send(text: string, via: "enter" | "followUp"): void {
    if (!indicator.running) startPrompt(text);
    else if (via === "followUp") void session.followUp(text).catch(() => undefined);
    else void session.steer(text).catch(() => undefined);
  }

  // ---- 键位 -----------------------------------------------------------------

  tui.addInputListener(
    createKeyDispatch({
      keys,
      editor,
      tools,
      status,
      session: () => session,
      inactive: () => finished || tui.hasOverlay,
      busy: () => indicator.busy,
      now,
      showHint,
      onExpandToggle: (expanded) => view.setThinkingExpanded(expanded),
      onStatusLineToggle: () => area.toggle(),
      onPasteImage: () => void agentUi.paste(),
      confirmMode,
      submit: (text, via) => submit(text, via),
      runCommand: (line) => void runCommand(line),
      exit: (code) => exit(code),
      onInterrupted: (empty) => void rewind.afterInterrupt(empty),
      agents: () => agentUi.keys,
    }),
  );

  // ---- 晚绑定 ---------------------------------------------------------------

  const overlayHooks = {
    showOverlay: (component: Component) => tui.showOverlay(component, { anchor: "bottom" }),
    onOpen: () => {
      editor.disableSubmit = true;
      tools.setAwaiting(true);
      indicator.setApproval(true);
    },
    onClose: () => {
      editor.disableSubmit = false;
      tools.setAwaiting(false);
      indicator.setApproval(false);
    },
  };
  const agentUi = new AgentUi({
    theme,
    tui,
    editor,
    tools: () => tools,
    subagents,
    session: () => session,
    dataDir: runtime.paths.dataDir,
    env,
    now,
    notice,
    panel: (component) => commandUi.panel?.(component),
    pick: (spec) => openPicker(pickerHost, spec),
    hint: (text) => showHint(text),
    render,
    switchSession: (request) => commandUi.switchSession(request),
    prompt: (text) => startPrompt(text),
    dialog: { theme, keybindings: keys, ...overlayHooks },
    displayPath: (path) => tildePath(path, home),
    ...(options.clipboard !== undefined ? { clipboard: options.clipboard } : {}),
    area,
  });
  const taskAgent = (taskId: string): string | undefined =>
    taskRegistryView(session.state.sessionId)?.get(taskId)?.agent;
  const broker = mergingBroker(
    new ApprovalDialogBroker({
      theme,
      keybindings: keys,
      cwd: session.state.cwd,
      permissionMode: () => session.state.permissionMode,
      taskAgent,
      externalRunner: (agent) => agentUi.merge.externalRunner(agent),
      ...overlayHooks,
      report: (request, outcome) => {
        if (outcome === "deny" || outcome === "cancelled") {
          const text = approvalOutcomeText(request, outcome, taskAgent);
          notice(outcome === "deny" ? "info" : "warn", text);
        }
      },
    }),
    agentUi.merge,
    (request) =>
      notice(
        "info",
        msg().interactive.app.followed(approvalOutcomeText(request, "allow", taskAgent)),
      ),
  );

  // ---- 启动与退出 -----------------------------------------------------------

  let offSignals: () => void = () => undefined;
  function exit(code: number): void {
    if (finished) return;
    finished = true;
    logoAnimation?.finish();
    if (hintTimer !== undefined) clearTimeout(hintTimer);
    loader.stop();
    area.dispose();
    // 退出摘要留在回滚里；输入框、状态栏等底部区域撤掉，屏幕停在摘要下面
    view.addExitSummary(exitSummaryLines(session.getStats(), now() - startedAt, theme));
    tui.clear();
    tui.addChild(view);
    offSignals();
    agentUi.detach();
    runtime.approvals.setUiBroker(undefined);
    runtime.notifier.set(undefined);
    tui.stop();
    const active = session;
    void active
      .abort()
      .catch(() => undefined)
      .finally(() => {
        unsubscribe();
        resolveExit(code);
      });
  }

  const startHeader = startupLevel === "silent" ? undefined : header(startupLevel);
  let logoAnimation: LogoAnimation | undefined;
  if (startHeader !== undefined) view.add(startHeader);
  for (const warning of startupWarnings) view.addNotice("warn", warning);
  replay();
  status.refresh();

  return new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    try {
      tui.start();
    } catch (error) {
      unsubscribe();
      reject(
        new AmaError(
          "terminal_init_failed",
          msg().interactive.app.terminalInitFailed(
            error instanceof Error ? error.message : String(error),
          ),
          { cause: error },
        ),
      );
      return;
    }
    runtime.approvals.setUiBroker(broker);
    runtime.notifier.set((message, level) => notice(level, message));
    agentUi.attach(session);
    offSignals = onTerminationSignals((code) => exit(code));
    tui.setFocus(editor);
    const gate = { animation: ui.animation, host: info.host !== undefined, env, ...context };
    logoAnimation = playStartupAnimation(tui, startHeader, theme, gate);
    options.onReady?.({
      tui,
      editor,
      view,
      tools,
      status,
      area,
      session: () => session,
      exit,
    });
    if (context.prompt !== undefined && context.prompt.trim() !== "") {
      editor.addToHistory(context.prompt);
      submit(context.prompt, "enter");
    }
  });
}
