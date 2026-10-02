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
 * - 键位（`keybindings.json` 可覆盖）：Enter 发送（运行中 = steer）、Alt+Enter followUp、
 *   Esc 中断（clearQueue 回填编辑器后 abort）、Alt+↑ 取回最后一条排队消息、Shift+Tab 循环权限模式、
 *   Ctrl+O 展开工具输出、Ctrl+L 模型、Ctrl+T 思考级别、Ctrl+C 清空输入 / 再按退出、Ctrl+D 空输入退出。
 * - 启动画面按 `ui.quietStartup`：normal 标题 + 模型 / 信任 / 资源清单，header 只有标题，silent 不输出。
 */

import { join } from "node:path";
import { AgentSessionImpl } from "../../agent/session.js";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import { currentSession, switchSession, type SwitchRequest } from "../../cli/compose-session.js";
import type { ModeContext } from "../../cli/deps.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import { buildStartupScreen } from "../../cli/startup-screen.js";
import { KEYBINDINGS_FILE } from "../../config/paths.js";
import { AmaError, isAmaError } from "../../errors.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../../permissions/types.js";
import {
  Container,
  Editor,
  Keybindings,
  Loader,
  ProcessTerminal,
  Spacer,
  TUI,
  Text,
  createTheme,
  detectCapabilities,
  loadKeybindingsFile,
  truncateToWidth,
  type Component,
  type Terminal,
  type Theme,
} from "../../tui.js";
import { onTerminationSignals } from "../shared.js";
import { ApprovalDialogBroker, approvalOutcomeText } from "./approval-dialog.js";
import { ALL_COMMANDS, runInteractiveCommand, type CommandUi } from "./commands.js";
import { InteractiveCompletion } from "./completion.js";
import { MessageView, type NoticeLevel } from "./message-view.js";
import { openPicker } from "./pickers.js";
import { StatusBar } from "./status-bar.js";
import { ToolTracker } from "./tool-view.js";

const DOUBLE_CTRL_C_MS = 1500;
const HINT_MS = 2500;
const QUEUE_PREVIEW = 3;

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
  /** 界面就绪后回调（测试驱动用）。 */
  onReady?(handle: InteractiveHandle): void;
}

export interface InteractiveHandle {
  readonly tui: TUI;
  readonly editor: Editor;
  readonly view: MessageView;
  readonly tools: ToolTracker;
  readonly status: StatusBar;
  session(): AgentSession;
  exit(code: number): void;
}

function processTerminal(): Terminal {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: unknown };
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== "function" || !process.stdout.isTTY) {
    throw new AmaError("terminal_init_failed", "stdin / stdout 不是终端");
  }
  return new ProcessTerminal();
}

function loadKeys(runtime: Runtime, warn: (m: string) => void): Keybindings {
  const parsed = loadKeybindingsFile(join(runtime.paths.configDir, KEYBINDINGS_FILE));
  for (const w of parsed.warnings) warn(`keybindings.json：${w}`);
  return new Keybindings(parsed.overrides);
}

/** 一行提示；空时不占行。 */
class HintLine implements Component {
  private text = "";

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    return this.text === "" ? [] : [truncateToWidth(this.text, width)];
  }

  invalidate(): void {}
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function runInteractiveMode(
  runtime: Runtime,
  context: ModeContext,
  options: InteractiveModeOptions = {},
): Promise<number> {
  const terminal = options.terminal ?? processTerminal();
  const ui = runtime.config.ui ?? {};
  const theme =
    options.theme ??
    createTheme(ui.theme ?? "dark", {
      caps: detectCapabilities(context.io.env as NodeJS.ProcessEnv, context.io.stdoutIsTTY),
    });
  const now = options.now ?? Date.now;
  const startupWarnings: string[] = [];
  const keys = options.keybindings ?? loadKeys(runtime, (m) => startupWarnings.push(m));

  let session = currentSession(runtime);
  const tui = new TUI(terminal);
  const view = new MessageView({
    theme,
    ...(ui.showThinking !== undefined ? { showThinking: ui.showThinking } : {}),
    ...(ui.markdown !== undefined ? { markdown: ui.markdown } : {}),
  });
  const tools = new ToolTracker({ theme, cwd: session.state.cwd });
  const queueText = new Text("");
  const loaderSlot = new Container();
  const loader = new Loader(() => tui.requestRender(), {
    theme,
    message: "工作中" + theme.fg("dim", " · Esc 中断"),
    now,
    ...(options.spinnerIntervalMs !== undefined ? { intervalMs: options.spinnerIntervalMs } : {}),
  });
  const hint = new HintLine();
  const status = new StatusBar(
    {
      session: () => session,
      preset: () => runtime.config.tools?.preset ?? "default",
      hostStatus: () => runtime.host?.status(),
    },
    theme,
  );
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
    autocomplete: completion,
    requestRender: () => tui.requestRender(),
    ...(historyFile !== undefined ? { historyFile } : {}),
    onSubmit: (text) => submit(text, "enter"),
  });

  tui.addChild(view);
  tui.addChild(new Spacer());
  tui.addChild(queueText);
  tui.addChild(loaderSlot);
  tui.addChild(editor);
  tui.addChild(hint);
  tui.addChild(status);

  // ---- 小工具 ---------------------------------------------------------------

  let finished = false;
  let running = false;
  let compacting = false;
  let ctrlCArmedAt = Number.NEGATIVE_INFINITY;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExit: (code: number) => void = () => undefined;

  const render = (): void => tui.requestRender();
  const notice = (level: NoticeLevel, text: string): void => {
    view.addNotice(level, text);
    render();
  };
  const showHint = (text: string): void => {
    hint.setText(text === "" ? "" : theme.fg("dim", text));
    if (hintTimer !== undefined) clearTimeout(hintTimer);
    hintTimer = undefined;
    if (text !== "") {
      hintTimer = setTimeout(() => {
        hint.setText("");
        render();
      }, HINT_MS);
      hintTimer.unref?.();
    }
    render();
  };
  const syncLoader = (): void => {
    const active = running || compacting;
    if (active && loaderSlot.children.length === 0) {
      loader.setMessage(
        (compacting && !running ? "压缩上下文" : "工作中") + theme.fg("dim", " · Esc 中断"),
      );
      loaderSlot.addChild(loader);
      loader.start();
    } else if (!active && loaderSlot.children.length > 0) {
      loader.stop();
      loaderSlot.clear();
    }
    render();
  };
  const setQueue = (steering: readonly string[], followUp: readonly string[]): void => {
    status.setQueue(steering.length, followUp.length);
    const rows = [
      ...steering.map((t) => `↳ steer  ${oneLine(t)}`),
      ...followUp.map((t) => `↳ followUp  ${oneLine(t)}`),
    ];
    const shown = rows.slice(-QUEUE_PREVIEW);
    if (rows.length > shown.length) shown.unshift(`… 另 ${rows.length - shown.length} 条`);
    if (rows.length > 0) shown.push("Alt+↑ 取回 · Esc 全部回填并中断");
    queueText.setText(shown.map((l) => theme.fg("dim", l)).join("\n"));
    render();
  };

  // ---- 会话事件 -------------------------------------------------------------

  const onEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case "agent_start":
        running = true;
        syncLoader();
        return;
      case "agent_settled":
        running = false;
        if (event.warning !== undefined) view.addNotice("warn", event.warning);
        status.refresh();
        syncLoader();
        return;
      case "message_start": {
        const message = event.message;
        if (message.role === "user") view.addUser(message);
        else if (message.role === "assistant") view.startAssistant(message);
        else if (message.role === "custom" && message.display) {
          view.addNotice("info", typeof message.content === "string" ? message.content : "");
        }
        render();
        return;
      }
      case "message_update":
        view.updateAssistant(event.message);
        render();
        return;
      case "message_end":
        if (event.message.role === "assistant") {
          view.endAssistant(event.message);
          status.refresh();
        }
        render();
        return;
      case "tool_execution_start": {
        const started = tools.start(event);
        if (started.topLevel) view.add(started.view);
        render();
        return;
      }
      case "tool_execution_update":
        tools.update(event.toolCallId, event.partial);
        render();
        return;
      case "tool_execution_end":
        tools.end(event.toolCallId, event.result, event.isError);
        render();
        return;
      case "queue_update":
        setQueue(event.steering, event.followUp);
        return;
      case "compaction_start":
        compacting = true;
        syncLoader();
        return;
      case "compaction_end":
        compacting = false;
        if (event.result !== undefined) view.addCompaction(event.result);
        else if (event.error !== undefined) view.addNotice("error", `压缩失败：${event.error}`);
        else if (event.aborted) view.addNotice("info", "压缩已取消");
        status.refresh();
        syncLoader();
        return;
      case "auto_retry_start":
        view.addRetry(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage);
        render();
        return;
      case "auto_retry_end":
        if (!event.success) view.addRetryFailed(event.finalError);
        render();
        return;
      case "permission_mode_changed":
      case "model_changed":
      case "thinking_level_changed":
      case "session_changed":
        status.refresh();
        render();
        return;
      default:
        return;
    }
  };
  let unsubscribe = session.subscribe(onEvent);

  const startup = buildStartupScreen(runtime);
  /** 清空消息区（切换会话、/tree）：只留标题行。 */
  const resetView = (): void => {
    view.reset();
    view.addHeader(startup.slice(0, 1));
  };

  const replay = (): void => {
    view.replay(session.messages, {
      tool: (call, result) =>
        tools.completed(
          call.id,
          call.name,
          call.arguments,
          result === undefined
            ? { content: "（没有结果）", isError: true }
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
    running = false;
    compacting = false;
    setQueue([], []);
    status.refresh();
    syncLoader();
    if (next instanceof AgentSessionImpl) next.announceStart(reason);
  };

  // ---- 提交与命令 -----------------------------------------------------------

  /**
   * 空闲时发提示。agent_settled 之后会话周期还要一个微任务才结束，所以先 waitForIdle；
   * 仍然撞上运行中（极少）就排到本轮之后。
   */
  const startPrompt = (text: string): void => {
    const target = session;
    void target
      .waitForIdle()
      .then(() => target.prompt(text))
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

  const commandUi: CommandUi = {
    runtime,
    session: () => session,
    async switchSession(request: SwitchRequest) {
      const next = await switchSession(runtime, request);
      rebind(next, request.kind === "new" ? "new" : request.kind === "fork" ? "fork" : "resume");
      return next;
    },
    pick: (spec) =>
      openPicker(
        {
          theme,
          keybindings: keys,
          showOverlay: (c, o) => tui.showOverlay(c, o),
          columns: () => terminal.columns,
        },
        spec,
      ),
    notice,
    setEditorText: (text) => {
      editor.setText(text);
      render();
    },
    prompt: (text) => startPrompt(text),
    reload: () => {
      resetView();
      tools.clear();
      replay();
      status.refresh();
      render();
    },
    exit: (code) => exit(code),
    now,
  };

  const runCommand = (line: string): Promise<boolean> =>
    runInteractiveCommand(line, commandUi).finally(() => {
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
    if (!running) startPrompt(text);
    else if (via === "followUp") void session.followUp(text).catch(() => undefined);
    else void session.steer(text).catch(() => undefined);
  }

  // ---- 键位 -----------------------------------------------------------------

  const interrupt = (): void => {
    const queued = session.clearQueue();
    const restore = [...queued.steering, ...queued.followUp];
    if (restore.length > 0) {
      const current = editor.getText();
      editor.setText([...restore, ...(current.trim() !== "" ? [current] : [])].join("\n"));
    }
    void session.abort().catch(() => undefined);
  };

  const dequeue = (): void => {
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
    const modes = PERMISSION_MODES_STRICT_FIRST;
    const index = modes.indexOf(session.state.permissionMode);
    const next = modes[(index + 1) % modes.length]!;
    session.setPermissionMode(next);
    status.refresh();
    showHint(`权限模式：${next}`);
  };

  tui.addInputListener((data) => {
    if (finished || tui.hasOverlay) return false;
    const is = (action: Parameters<Keybindings["matches"]>[1]): boolean =>
      keys.matches(data, action);
    if (is("app.clear")) {
      if (!editor.isEmpty()) {
        editor.clear();
        ctrlCArmedAt = now();
        showHint("已清空输入 · 再按 Ctrl+C 退出");
      } else if (now() - ctrlCArmedAt < DOUBLE_CTRL_C_MS) {
        exit(ExitCode.Sigint);
      } else {
        ctrlCArmedAt = now();
        showHint("再按一次 Ctrl+C 退出");
      }
      return true;
    }
    ctrlCArmedAt = Number.NEGATIVE_INFINITY;
    if (is("app.interrupt") && !editor.isCompletionOpen && (running || compacting)) {
      interrupt();
      showHint("已中断");
      return true;
    }
    if (is("app.exit") && editor.isEmpty()) {
      exit(ExitCode.Ok);
      return true;
    }
    if (is("app.message.followUp")) {
      const text = editor.takeSubmission();
      if (text !== null) submit(text, "followUp");
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
      showHint(expanded ? "工具输出：展开" : "工具输出：折叠");
      return true;
    }
    if (is("app.model.select")) {
      void runCommand("/model");
      return true;
    }
    if (is("app.thinking.select")) {
      void runCommand("/thinking");
      return true;
    }
    return false;
  });

  // ---- 晚绑定 ---------------------------------------------------------------

  const broker = new ApprovalDialogBroker({
    theme,
    keybindings: keys,
    cwd: session.state.cwd,
    permissionMode: () => session.state.permissionMode,
    showOverlay: (component) => tui.showOverlay(component, { anchor: "bottom" }),
    onOpen: () => {
      editor.disableSubmit = true;
      render();
    },
    onClose: () => {
      editor.disableSubmit = false;
      render();
    },
    report: (request, outcome) => {
      if (outcome === "deny" || outcome === "cancelled") {
        notice(outcome === "deny" ? "info" : "warn", approvalOutcomeText(request, outcome));
      }
    },
  });

  // ---- 启动与退出 -----------------------------------------------------------

  let offSignals: () => void = () => undefined;
  function exit(code: number): void {
    if (finished) return;
    finished = true;
    if (hintTimer !== undefined) clearTimeout(hintTimer);
    hint.setText("");
    loader.stop();
    loaderSlot.clear();
    offSignals();
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

  view.addHeader(startup);
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
          `终端初始化失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
      return;
    }
    runtime.approvals.setUiBroker(broker);
    runtime.notifier.set((message, level) => notice(level, message));
    offSignals = onTerminationSignals((code) => exit(code));
    tui.setFocus(editor);
    options.onReady?.({
      tui,
      editor,
      view,
      tools,
      status,
      session: () => session,
      exit,
    });
    if (context.prompt !== undefined && context.prompt.trim() !== "") {
      editor.addToHistory(context.prompt);
      submit(context.prompt, "enter");
    }
  });
}
