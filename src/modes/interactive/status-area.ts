/**
 * 交互界面的底部区域：提示行、速率行（status-line.ts）与状态栏（status-bar.ts）的装配。[W5-A]
 *
 * - 布局 `ui.statusLine`（独立终端缺省 full；有 profile 时 PROFILE_DEFAULTS 给 compact）；运行时 Ctrl+G
 *   （`app.statusLine.toggle`）或 `/statusline [full|compact]` 切换，只影响本会话（本进程），不写配置。
 * - 会话时长从本进程打开当前会话（含 /new /resume /fork 切换）起算，用界面的时钟。
 * - git：`GitInfoWatcher` 在回合边界刷新——agent_settled、写类工具（write / edit / bash / task）结束、
 *   session_rewound、/tree 之后；结果变化时重画。
 * - `telemetry_tick`（流式中 ≤ 2 Hz）只重取统计并重画（速率行），状态栏的内容这时不变。
 */

import { basename } from "node:path";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import { sandboxCapabilityFor } from "../../codemode/capability.js";
import type { Runtime } from "../../cli/runtime.js";
import type { StatusLineMode } from "../../config/types.js";
import { GitInfoWatcher } from "../../git/info.js";
import { effectiveCodemodeMode } from "../../tools/presets.js";
import { truncateToWidth, type Component, type Theme } from "../../tui.js";
import { StatusBar, type StatusBarSource } from "./status-bar.js";
import { StatusLine } from "./status-line.js";

/** 结束后可能改了工作区的工具。 */
const WRITE_TOOLS = new Set(["write", "edit", "bash", "task"]);

/** 一行提示；空时不占行。 */
export class HintLine implements Component {
  private text = "";

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    return this.text === "" ? [] : [truncateToWidth(this.text, width)];
  }

  invalidate(): void {}
}

export interface StatusAreaDeps {
  runtime: Runtime;
  theme: Theme;
  session(): AgentSession;
  now(): number;
  render(): void;
  /**
   * 布局切换后整屏重画（行数变了，差分渲染会在屏底留一空行，宿主按「最后一行 = 状态栏」锚定会错位）；
   * 缺省 render。
   */
  redraw?(): void;
  /** 初始布局（缺省按配置）。 */
  layout?: StatusLineMode;
  env?: NodeJS.ProcessEnv;
}

export class StatusArea {
  readonly hint = new HintLine();
  readonly bar: StatusBar;
  readonly rate: StatusLine;
  private mode: StatusLineMode;
  private startedAt: number;
  private git: GitInfoWatcher | undefined;
  private gitCwd: string | undefined;
  private offGit: () => void = () => undefined;
  private sandboxStrict: boolean | undefined;

  constructor(private readonly deps: StatusAreaDeps) {
    const { runtime } = deps;
    this.mode = deps.layout ?? runtime.config.ui?.statusLine ?? "full";
    this.startedAt = deps.now();
    const source: StatusBarSource = {
      session: () => deps.session(),
      preset: () => runtime.config.tools?.preset ?? "default",
      hostStatus: () => runtime.host?.status(),
      codemode: () => {
        const mode = effectiveCodemodeMode(runtime.config);
        const active = deps
          .session()
          .getTools()
          .some((tool) => tool.name === "codemode");
        return mode === "off" || !active ? undefined : mode;
      },
      // S2：Node 权限模型与 OS 沙箱都不隔离网络时才标 net!（尊重 sandbox.enabled）
      sandboxStrict: () => (this.sandboxStrict ??= sandboxCapabilityFor(runtime.config).strict),
      layout: () => this.mode,
      git: () => this.gitView(),
      now: () => deps.now(),
      sessionStartedAt: () => this.startedAt,
    };
    this.bar = new StatusBar(source, deps.theme);
    this.rate = new StatusLine(this.bar, source, deps.theme);
    this.watchGit();
  }

  layout(): StatusLineMode {
    return this.mode;
  }

  setLayout(mode: StatusLineMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    (this.deps.redraw ?? this.deps.render)();
  }

  toggle(): StatusLineMode {
    this.setLayout(this.mode === "full" ? "compact" : "full");
    return this.mode;
  }

  refresh(): void {
    this.bar.refresh();
  }

  /** 换了会话（/new /resume /fork）：时长重新起算，cwd 变了就换 git 监视。 */
  rebind(): void {
    this.startedAt = this.deps.now();
    this.watchGit();
    this.bar.refresh();
  }

  refreshGit(): void {
    void this.git?.refresh();
  }

  /** 返回 true：事件已处理完（只需重画），调用方不再分派。 */
  onEvent(event: SessionEvent): boolean {
    switch (event.type) {
      case "telemetry_tick":
        this.bar.refresh();
        return true;
      case "agent_settled":
      case "session_rewound":
        this.refreshGit();
        return false;
      case "tool_execution_end":
        if (WRITE_TOOLS.has(event.toolName)) this.refreshGit();
        return false;
      default:
        return false;
    }
  }

  dispose(): void {
    this.offGit();
    this.git?.dispose();
    this.git = undefined;
  }

  private gitView(): { dir: string; info: ReturnType<GitInfoWatcher["current"]> } | undefined {
    const cwd = this.gitCwd;
    if (cwd === undefined) return undefined;
    return { dir: basename(cwd), info: this.git?.current() };
  }

  private watchGit(): void {
    const cwd = this.deps.session().state.cwd;
    if (cwd === this.gitCwd && this.git !== undefined) return;
    this.dispose();
    this.gitCwd = cwd;
    const git = new GitInfoWatcher(cwd, this.deps.env !== undefined ? { env: this.deps.env } : {});
    this.git = git;
    this.offGit = git.onChange(() => this.deps.render());
    void git.refresh();
  }
}

/**
 * `/statusline [full|compact]`（无参数切换）：是这条命令就处理并返回 true，否则 false 交给其它命令。
 * line 模式没有底部信息行，commands-core 只登记命令名、回一句说明。
 */
export function statusLineSlash(
  area: StatusArea,
  line: string,
  notice: (level: "info" | "error", text: string) => void,
): boolean {
  const match = /^\/statusline(?:\s+(.*))?$/i.exec(line.trim());
  if (match === null) return false;
  const value = (match[1] ?? "").trim();
  if (value === "") area.toggle();
  else if (value === "full" || value === "compact") area.setLayout(value);
  else {
    notice("error", "用法：/statusline [full|compact]");
    return true;
  }
  notice("info", statusLineText(area.layout()));
  return true;
}

export function statusLineText(mode: StatusLineMode): string {
  return mode === "full" ? "状态栏：完整（两行）" : "状态栏：精简（一行）";
}
