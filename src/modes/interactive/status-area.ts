/**
 * 交互界面的底部区域：提示行、速率行（status-line.ts）与状态栏（status-bar.ts）的装配。[W5-A]
 *
 * - 布局 `ui.statusLine`（独立终端缺省 full；有 profile 时 PROFILE_DEFAULTS 给 compact）；运行时 Ctrl+G
 *   （`app.statusLine.toggle`）或 `/statusline [full|compact]` 切换，只影响本会话（本进程），不写配置。
 * - 会话时长从本进程打开当前会话（含 /new /resume /fork 切换）起算，用界面的时钟。
 * - git：`GitInfoWatcher` 在回合边界刷新——agent_settled、写类工具（write / edit / bash / task）结束、
 *   session_rewound、/tree 之后；结果变化时重画。
 * - [W5-U] `model_fallback` 之后状态栏模型项显示 `主模型 → 回退模型`，切回主模型（`model_changed`）后消失。
 * - `telemetry_tick`（流式中 ≤ 2 Hz）只重取统计并重画（速率行），状态栏的内容这时不变。
 * - [W6] 订阅配额（status-quota.ts）：记住最近一次 `quota_update`（账户级，换会话不清；换到别的供应商不显示），
 *   full 时在状态栏下方占第三行、compact 时在行尾追加短项；第三行显示中每分钟重画一次（重置倒计时），
 *   不显示时不挂计时器。Ctrl+G 折叠时第三行与速率行一起收起。
 */

import { msg } from "../../i18n/index.js";
import { basename } from "node:path";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import { sandboxCapabilityFor } from "../../codemode/capability.js";
import type { Runtime } from "../../cli/runtime.js";
import type { StatusLineMode } from "../../config/types.js";
import { formatModelRef } from "../../ai/providers/channels.js";
import { GitInfoWatcher } from "../../git/info.js";
import { resolveBashSandbox } from "../../sandbox/bash.js";
import { osSandboxStatus } from "../../sandbox/detect.js";
import { effectiveCodemodeMode } from "../../tools/presets.js";
import { truncateToWidth, type Component, type Theme } from "../../tui.js";
import { StatusBar, type StatusBarSource } from "./status-bar.js";
import { StatusLine } from "./status-line.js";
import { QuotaLine, type QuotaView } from "./status-quota.js";
import type { QuotaUpdateEvent } from "../../agent/types-w6.js";

/** 结束后可能改了工作区的工具。 */
const WRITE_TOOLS = new Set(["write", "edit", "bash", "task"]);
/** 配额行重画间隔（倒计时只到分钟）。 */
export const QUOTA_TICK_MS = 60_000;

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
  /** [W6] 订阅配额行（full 第三行）。 */
  readonly quota: QuotaLine;
  private lastQuota: QuotaUpdateEvent | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private mode: StatusLineMode;
  private startedAt: number;
  private git: GitInfoWatcher | undefined;
  private gitCwd: string | undefined;
  private offGit: () => void = () => undefined;
  private sandboxStrict: boolean | undefined;
  /** [W5-U] 模型回退中（`model_fallback` 到切回主模型）。 */
  private fallback: { from: string; to: string } | undefined;
  private bashSandbox: boolean | undefined;

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
      fallback: () => this.fallback,
      // S2：bash 沙箱生效（配置 + 本机能力，与 compose 同一结论）且 bash 工具活动
      bashSandbox: () =>
        (this.bashSandbox ??= resolveBashSandbox(runtime.config.sandbox, {
          status: osSandboxStatus(),
        }).active) &&
        deps
          .session()
          .getTools()
          .some((tool) => tool.name === "bash"),
      quota: () => this.quotaView(),
    };
    this.bar = new StatusBar(source, deps.theme);
    this.rate = new StatusLine(this.bar, source, deps.theme);
    this.quota = new QuotaLine(
      { layout: () => this.mode, quota: () => this.quotaView(), now: () => deps.now() },
      deps.theme,
    );
    this.watchGit();
    this.syncTicker();
  }

  /** [W6] 当前模型走 ChatGPT 订阅时的配额；codex 还没数据为 pending，SIWC 没数据或非订阅模型不显示。 */
  quotaView(): QuotaView {
    const model = this.deps.session().state.model;
    if (model === undefined) return undefined;
    const backend = this.backendOf(formatModelRef(model));
    if (backend === undefined) return undefined;
    const quota = this.lastQuota ?? this.deps.session().getStats().subscription?.quota;
    if (quota !== undefined && quota.provider === model.provider) return { quota };
    return backend === "codex" ? "pending" : undefined;
  }

  private backendMemo: { ref: string; backend: "codex" | "siwc" | undefined } | undefined;

  /** 模型的 ChatGPT 订阅后端（渠道 compat `chatgptBackend`）；按引用记住上次结果。 */
  private backendOf(ref: string): "codex" | "siwc" | undefined {
    if (this.backendMemo?.ref === ref) return this.backendMemo.backend;
    const found = this.deps.runtime.providers.findModel(ref);
    const value = found.ok
      ? (found.model.compat as { chatgptBackend?: unknown } | undefined)?.chatgptBackend
      : undefined;
    const backend = value === "codex" || value === "siwc" ? value : undefined;
    this.backendMemo = { ref, backend };
    return backend;
  }

  /** 第三行显示且有重置时间时每分钟重画；否则不挂计时器。 */
  private syncTicker(): void {
    const view = this.mode === "full" ? this.quotaView() : undefined;
    const ticking =
      typeof view === "object" &&
      (view.quota.primary?.resetsAt !== undefined || view.quota.secondary?.resetsAt !== undefined);
    if (ticking && this.ticker === undefined) {
      this.ticker = setInterval(() => this.deps.render(), QUOTA_TICK_MS);
      this.ticker.unref?.();
    } else if (!ticking && this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  layout(): StatusLineMode {
    return this.mode;
  }

  /** [W6-A] 界面配置（Agent 栏开关、子 Agent 视图的消息显示选项）。 */
  ui(): NonNullable<Runtime["config"]["ui"]> {
    return this.deps.runtime.config.ui ?? {};
  }

  setLayout(mode: StatusLineMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.syncTicker();
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
    this.fallback = undefined;
    this.watchGit();
    this.bar.refresh();
    this.syncTicker();
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
      case "quota_update":
        this.lastQuota = event;
        this.syncTicker();
        return true;
      case "agent_settled":
      case "session_rewound":
        this.refreshGit();
        return false;
      case "tool_execution_end":
        if (WRITE_TOOLS.has(event.toolName)) this.refreshGit();
        return false;
      case "model_fallback":
        this.fallback = {
          from: formatModelRef(event.from),
          to: formatModelRef(event.to),
        };
        this.bar.refresh();
        return false;
      case "model_changed": {
        const model = this.deps.session().state.model;
        if (this.fallback !== undefined && model !== undefined) {
          if (formatModelRef(model) === this.fallback.from) this.fallback = undefined;
        }
        this.syncTicker();
        return false;
      }
      default:
        return false;
    }
  }

  dispose(): void {
    this.disposeGit();
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private disposeGit(): void {
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
    this.disposeGit();
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
    notice("error", msg().interactive.statusLine.usage);
    return true;
  }
  notice("info", statusLineText(area.layout()));
  return true;
}

export function statusLineText(mode: StatusLineMode): string {
  const m = msg().interactive.statusLine;
  return mode === "full" ? m.full : m.compact;
}
