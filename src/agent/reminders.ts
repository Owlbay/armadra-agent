/**
 * 统一提醒通道 `ama.reminder`（docs/history/wave5-plan.md §8.3 H3，D29）。[W5-H2]
 *
 * 以 `SessionExtension` 实现，两个投递点，都只追加在尾部（design §9.1，缓存前缀不动）：
 * - **新提示**：`beforePrompts` 追加一条 `custom_message{customType:"ama.reminder", display:false}`；
 * - **run 进行中**：在 agent_start 时以本 run 的 signal 登记批次尾部来源（tool-runner.ts
 *   `setBatchSuffixSource`），每个工具批次结束时把到期提醒追加在本批最后一条结果末尾
 *   （`<system-reminder>` 包起来）。不用 steer 队列：那会占用户的投递位、Esc 时还会被回填进编辑器。
 *
 * 提醒种类（`reminders.*` 逐项可关，缺省全开）：
 * 1. `todo`：todo 工具在活动集、清单有未完成项、连续 `todo.reminder`（缺省 10，0 关闭）次助手回复
 *    没更新清单（`ama.todo` 条目）→ 复述清单，计数清零；
 * 2. `fileChanges`：本会话 read / edit / write 过的文件 mtime 或大小变了（不是本 Agent 的编辑或 bash
 *    改的：这些之后重新取基线）→ 列出 ≤ 10 个，附 `git diff --stat`（拿得到时）；
 * 3. `contextPressure`：上下文估算（compaction/estimate.ts 的口径）到窗口 70% / 85% 各一次，
 *    压缩后回落再重新计；
 * 4. `budget`：limits 的回合或费用用掉 ≥ 80%（剩余 < 20%）时每次运行各一次；
 * 5. 后台命令退出（不可关）：`bash{background}` 的任务退出且模型还没经 wait / output 看到 →
 *    「后台命令 bgN 已退出（码 N）」。
 *
 * 后台任务表的生命周期也挂在这里：任务事件转成 `background_job`，会话 dispose 时回收进程树。
 * task 子会话（depth > 0）只装后台任务部分。
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { estimateProjectedTokens } from "../compaction/estimate.js";
import type { RemindersConfig } from "../config/types-w5.js";
import { buildProjection } from "../session/projection.js";
import type { AgentMessage, SessionEntry } from "../session/types.js";
import { disposeSessionJobs, jobsForSession, type Job } from "../tools/background-jobs.js";
import { TODO_CUSTOM_TYPE, parseTodoState, renderTodoList } from "../tools/todo.js";
import { budgetOf } from "./limits.js";
import type { SessionCore } from "./session-core.js";
import type { SessionExtension } from "./session-extensions.js";
import { setBatchSuffixSource } from "./tool-runner.js";
import type { SessionEvent } from "./types.js";

export const REMINDER_CUSTOM_TYPE = "ama.reminder";
export const DEFAULT_TODO_REMINDER_TURNS = 10;
export const CONTEXT_REMINDER_RATIOS = [0.7, 0.85] as const;
export const BUDGET_REMINDER_RATIO = 0.8;
export const MAX_CHANGED_FILES = 10;

export interface RemindersSettings {
  reminders?: RemindersConfig;
  /** `todo.reminder`：连续多少次回复未更新清单就复述；0 关闭。 */
  todoEvery?: number;
}

/** config → 提醒设置（`reminders.*` 与 `todo.reminder`）。 */
export function remindersSettings(config: {
  reminders?: RemindersConfig | undefined;
  todo?: { reminder?: number | undefined } | undefined;
}): RemindersSettings {
  const settings: RemindersSettings = {};
  if (config.reminders !== undefined) settings.reminders = config.reminders;
  if (config.todo?.reminder !== undefined) settings.todoEvery = config.todo.reminder;
  return settings;
}

export interface RemindersDeps {
  /** `git diff --stat -- <files>`；拿不到返回 undefined。测试注入。 */
  diffStat?(cwd: string, files: readonly string[]): string | undefined;
  stat?(path: string): { mtimeMs: number; size: number } | undefined;
}

const FILE_TOOLS = new Set(["read", "edit", "write"]);

function defaultStat(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const info = statSync(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return undefined;
  }
}

function defaultDiffStat(cwd: string, files: readonly string[]): string | undefined {
  try {
    const out = execFileSync("git", ["diff", "--stat", "--", ...files], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

function lastTodo(branch: readonly SessionEntry[]) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === TODO_CUSTOM_TYPE)
      return parseTodoState(entry.data);
  }
  return parseTodoState(undefined);
}

function wrap(lines: readonly string[]): string {
  return `<system-reminder>\n${lines.join("\n\n")}\n</system-reminder>`;
}

function argPath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" && path !== "" ? path : undefined;
}

class Reminders {
  private readonly on: Required<RemindersConfig>;
  private readonly todoEvery: number;
  private readonly stat: NonNullable<RemindersDeps["stat"]>;
  private readonly diffStat: NonNullable<RemindersDeps["diffStat"]>;
  /** 自上次更新 todo 以来的助手回复数。 */
  private sinceTodo = 0;
  /** 已提醒过的上下文档位（压缩后回落再清）。 */
  private readonly contextFired = new Set<number>();
  /** 本次运行已提醒的预算类别。 */
  private readonly budgetFired = new Set<"turns" | "cost">();
  /** 文件基线：绝对路径 → mtime / 大小。 */
  private readonly baseline = new Map<string, { mtimeMs: number; size: number } | undefined>();
  /** toolCallId → 文件工具的绝对路径。 */
  private readonly pendingPaths = new Map<string, string>();

  constructor(
    private readonly core: SessionCore,
    settings: RemindersSettings,
    deps: RemindersDeps,
  ) {
    const r = settings.reminders ?? {};
    this.on = {
      todo: r.todo ?? true,
      fileChanges: r.fileChanges ?? true,
      contextPressure: r.contextPressure ?? true,
      budget: r.budget ?? true,
    };
    this.todoEvery = settings.todoEvery ?? DEFAULT_TODO_REMINDER_TURNS;
    this.stat = deps.stat ?? defaultStat;
    this.diffStat = deps.diffStat ?? defaultDiffStat;
  }

  onEvent(event: SessionEvent): void {
    switch (event.type) {
      case "before_agent_start":
        this.budgetFired.clear();
        return;
      case "agent_start": {
        const signal = this.core.agent.signal;
        if (signal !== undefined) setBatchSuffixSource(signal, () => this.collect(true));
        return;
      }
      case "message_end":
        if (
          event.message.role === "assistant" &&
          event.message.stopReason !== "error" &&
          event.message.stopReason !== "aborted"
        )
          this.sinceTodo++;
        return;
      case "entry_appended":
        if (event.entry.type === "custom" && event.entry.customType === TODO_CUSTOM_TYPE)
          this.sinceTodo = 0;
        return;
      case "compaction_end":
        this.rearmContext();
        return;
      case "tool_execution_start": {
        if (event.parentToolCallId !== undefined || !FILE_TOOLS.has(event.toolName)) return;
        const path = argPath(event.args);
        if (path !== undefined)
          this.pendingPaths.set(event.toolCallId, resolve(this.core.cwd, path));
        return;
      }
      case "tool_execution_end": {
        const path = this.pendingPaths.get(event.toolCallId);
        this.pendingPaths.delete(event.toolCallId);
        if (path !== undefined && !event.isError) this.baseline.set(path, this.stat(path));
        // 本 Agent 自己的 bash 改动模型知道：重新取基线，只报其余来源的改动
        else if (event.toolName === "bash" && event.parentToolCallId === undefined)
          this.rebaseline();
        return;
      }
      default:
        return;
    }
  }

  /** 到期提醒的正文（没有返回 undefined）；`inRun` = 工具批次尾部（预算提醒只在 run 中有意义）。 */
  collect(inRun: boolean): string | undefined {
    const lines: string[] = [];
    const jobs = this.jobLines();
    const todo = this.todoLine();
    const files = this.fileLine();
    const context = this.contextLine();
    const budget = inRun ? this.budgetLine() : undefined;
    for (const line of [jobs, todo, files, context, budget])
      if (line !== undefined) lines.push(line);
    return lines.length === 0 ? undefined : wrap(lines);
  }

  private jobLines(): string | undefined {
    const exited = jobsForSession(this.core.manager.id).takeExited();
    if (exited.length === 0) return undefined;
    return exited.map((job) => jobExitText(job)).join("\n");
  }

  private todoLine(): string | undefined {
    if (!this.on.todo || this.todoEvery <= 0 || this.sinceTodo < this.todoEvery) return undefined;
    if (this.core.activeTool("todo") === undefined) return undefined;
    const { items } = lastTodo(this.core.manager.branch());
    if (!items.some((item) => item.status !== "done")) return undefined;
    const turns = this.sinceTodo;
    this.sinceTodo = 0;
    return (
      `The todo list has not been updated in the last ${turns} replies and still has open items:\n` +
      `${renderTodoList(items).join("\n")}\n` +
      "If you made progress, update it (todo update); otherwise keep going. Do not mention this reminder."
    );
  }

  private fileLine(): string | undefined {
    if (!this.on.fileChanges || this.baseline.size === 0) return undefined;
    const changed: string[] = [];
    for (const [path, before] of this.baseline) {
      const now = this.stat(path);
      if (before?.mtimeMs === now?.mtimeMs && before?.size === now?.size) continue;
      this.baseline.set(path, now);
      changed.push(now === undefined ? `${path} (deleted)` : path);
    }
    if (changed.length === 0) return undefined;
    const shown = changed.slice(0, MAX_CHANGED_FILES);
    const more =
      changed.length > shown.length ? `\n…and ${changed.length - shown.length} more` : "";
    const existing = shown.filter((p) => !p.endsWith(" (deleted)"));
    const stat = existing.length > 0 ? this.diffStat(this.core.cwd, existing) : undefined;
    return (
      "These files changed outside your own edits since you last read them; re-read before editing:\n" +
      `${shown.map((p) => `- ${p}`).join("\n")}${more}` +
      (stat === undefined ? "" : `\ngit diff --stat:\n${stat}`)
    );
  }

  private contextLine(): string | undefined {
    if (!this.on.contextPressure) return undefined;
    const window = this.core.model().contextWindow;
    if (window === undefined || window <= 0) return undefined;
    const ratio = this.usedTokens() / window;
    let fired: number | undefined;
    for (const level of CONTEXT_REMINDER_RATIOS)
      if (ratio >= level && !this.contextFired.has(level)) fired = level;
    if (fired === undefined) return undefined;
    for (const level of CONTEXT_REMINDER_RATIOS) if (level <= fired) this.contextFired.add(level);
    const pct = Math.round(ratio * 100);
    return fired >= 0.85
      ? `Context is ${pct}% full. Finish the current step soon and write down progress and next steps (todo or a notes file); older history will be compacted.`
      : `Context is ${pct}% full. Prefer targeted reads and keep notes of key findings; older history will be compacted when it fills up.`;
  }

  private budgetLine(): string | undefined {
    if (!this.on.budget) return undefined;
    const budget = budgetOf(this.core);
    if (budget === undefined) return undefined;
    const parts: string[] = [];
    const { maxTurns, maxCostUsd } = budget;
    if (
      maxTurns !== undefined &&
      !this.budgetFired.has("turns") &&
      budget.turns >= maxTurns * BUDGET_REMINDER_RATIO
    ) {
      this.budgetFired.add("turns");
      parts.push(`${budget.turns} of ${maxTurns} turns`);
    }
    if (
      maxCostUsd !== undefined &&
      !this.budgetFired.has("cost") &&
      budget.spentUsd >= maxCostUsd * BUDGET_REMINDER_RATIO
    ) {
      this.budgetFired.add("cost");
      parts.push(`$${budget.spentUsd.toFixed(2)} of the $${maxCostUsd.toFixed(2)} budget`);
    }
    if (parts.length === 0) return undefined;
    return `This run has used ${parts.join(" and ")}. Wrap up: finish the most important part and report what is left.`;
  }

  private usedTokens(): number {
    const branch = this.core.manager.branch();
    return estimateProjectedTokens(buildProjection(branch).items, branch).tokens;
  }

  private rearmContext(): void {
    const window = this.core.model().contextWindow;
    if (window === undefined || window <= 0) return;
    const ratio = this.usedTokens() / window;
    for (const level of CONTEXT_REMINDER_RATIOS) if (ratio < level) this.contextFired.delete(level);
  }

  private rebaseline(): void {
    for (const path of this.baseline.keys()) this.baseline.set(path, this.stat(path));
  }
}

export function jobExitText(job: Job): string {
  const how =
    job.status === "stopped" ? "was stopped" : `exited with code ${job.exitCode ?? "unknown"}`;
  return `Background job ${job.id} (\`${job.command}\`) ${how}; output: ${job.outputPath} (bash {"job":"${job.id}","action":"output"}).`;
}

export function reminderMessage(text: string): AgentMessage {
  return {
    role: "custom",
    customType: REMINDER_CUSTOM_TYPE,
    content: text,
    display: false,
    timestamp: Date.now(),
  };
}

/**
 * 提醒扩展。主会话：全部提醒 + 后台任务生命周期；子会话：只管后台任务（事件与回收）。
 */
export function createRemindersExtension(
  core: SessionCore,
  settings: RemindersSettings = {},
  deps: RemindersDeps = {},
): SessionExtension {
  const sessionId = core.manager.id;
  const jobs = jobsForSession(sessionId);
  const offJobs = jobs.onChange(({ phase, job }) => {
    core.emit({
      type: "background_job",
      jobId: job.id,
      phase,
      command: job.command,
      ...(job.pid === undefined ? {} : { pid: job.pid }),
      outputPath: job.outputPath,
      ...(phase === "started" ? {} : { exitCode: job.exitCode ?? null }),
    });
  });
  const dispose = (): void => {
    offJobs();
    void disposeSessionJobs(sessionId);
  };
  if (core.depth > 0) return { id: "reminders", dispose };
  const reminders = new Reminders(core, settings, deps);
  return {
    id: "reminders",
    onEvent: (event) => reminders.onEvent(event),
    beforePrompts(): AgentMessage[] {
      const text = reminders.collect(false);
      return text === undefined ? [] : [reminderMessage(text)];
    },
    dispose,
  };
}
