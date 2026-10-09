/**
 * 交互界面的终端程序状态（OSC 7501，src/tui/program-status.ts）：会话事件 → 根记录与子任务记录。
 *
 * 根记录（优先级自上而下）：
 *   有待人处理的审批 → blocked:permission（msg = 工具 · 目标）
 *   有待审批的计划 → blocked:question
 *   上一回合因登录失效失败（`auth_expired`）→ blocked:auth（下一回合开始或换模型时解除）
 *   回合进行中 → working（msg = 思考中 / 回复中 / 运行 bash / 压缩上下文，节流 + 同值去重）
 *   回合结束 → done；出错 → error（msg = 错误首行）；用户中断 → idle；之后用户再按键 → idle
 *   启动 / 切换会话 → idle
 * 子记录：子 Agent 任务 `id=task/<短 id>`、title = 任务描述，working / blocked / done / error（中断为 idle）；
 * 下一个主回合开始时清掉已结束的任务记录。退出交互模式前发不带 id 的 `state=clear`（用户主动退出，
 * 不留记录）。
 *
 * 只在交互 TUI 里启用；print / rpc / acp 的 stdout 是数据或协议，不发。
 */

import type { SessionEvent } from "../../agent/types.js";
import type { Runtime } from "../../cli/runtime.js";
import { msg } from "../../i18n/index.js";
import {
  ProgramStatusEmitter,
  idSegment,
  type BlockedKind,
  type ProgramStatusReport,
} from "../../tui/program-status.js";
import type { TUI } from "../../tui.js";
import { flat, toolSummary } from "./tool-summary.js";

const AUTH_EXPIRED = /\bauth_expired\b/;

export interface ProgramStatusOptions {
  /** 检测超时（ms），缺省 300。 */
  timeoutMs?: number;
  /** 同一状态下 msg 更新的最小间隔（ms），缺省 500。 */
  throttleMs?: number;
}

type Outcome = { state: "done" | "error" | "idle"; msg?: string };
interface TaskRecord {
  id: string;
  title: string;
  state: "working" | "blocked" | "done" | "error" | "idle";
  msg?: string;
}
interface Pending {
  msg: string;
  taskId?: string;
}

/** 会话事件 → 状态记录（只读事件，不改会话）。 */
export class ProgramStatusTracker {
  private running = false;
  private activity: string | undefined;
  private readonly approvals = new Map<string, Pending>();
  private plan: string | undefined;
  private auth: string | undefined;
  private outcome: Outcome | undefined;
  private lastError: string | undefined;
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(
    private readonly emitter: Pick<ProgramStatusEmitter, "report">,
    private readonly cwd: () => string | undefined = () => undefined,
  ) {}

  onEvent(event: SessionEvent): void {
    const run = msg().interactive.view.run;
    switch (event.type) {
      case "session_start":
        if (event.reason !== "startup") this.reset();
        break;
      case "agent_start":
        this.running = true;
        this.activity = run.thinking;
        this.outcome = this.auth = this.lastError = undefined;
        for (const [key, task] of this.tasks)
          if (task.state !== "working" && task.state !== "blocked") this.dropTask(key);
        break;
      case "message_update": {
        const last = event.message.content.at(-1);
        this.activity = last?.type === "text" ? run.replying : run.thinking;
        break;
      }
      case "tool_execution_start":
        if (event.parentToolCallId === undefined) this.activity = run.runningTool(event.toolName);
        break;
      case "compaction_start":
        this.activity = run.compacting;
        break;
      case "message_end":
        if (event.message.role === "assistant" && event.message.stopReason === "error")
          this.lastError = event.message.errorMessage ?? "error";
        break;
      case "agent_end":
        if (!event.willRetry) this.outcome = this.outcomeOf(event.stopReason);
        break;
      case "agent_settled":
        this.running = false;
        this.outcome ??= { state: "done" };
        break;
      case "permission_request": {
        const summary = flat(toolSummary(event.toolName, event.input, this.cwd()), 80);
        const text = summary === "" ? event.toolName : `${event.toolName} · ${summary}`;
        const taskId = event.context?.taskId;
        this.approvals.set(event.requestId, { msg: text, ...(taskId ? { taskId } : {}) });
        const task = taskId !== undefined ? this.tasks.get(taskId) : undefined;
        if (task !== undefined) Object.assign(task, { state: "blocked", msg: text });
        break;
      }
      case "permission_resolved": {
        const taskId = this.approvals.get(event.requestId)?.taskId;
        this.approvals.delete(event.requestId);
        const task = taskId !== undefined ? this.tasks.get(taskId) : undefined;
        const still = [...this.approvals.values()].some((p) => p.taskId === taskId);
        if (task?.state === "blocked" && !still) Object.assign(task, { state: "working" });
        break;
      }
      case "plan_proposed":
        this.plan = msg().plan.dialog.title;
        break;
      case "plan_resolved":
        this.plan = undefined;
        break;
      case "model_changed":
        this.auth = undefined;
        break;
      case "subagent_start":
        this.tasks.set(event.taskId, {
          id: `task/${idSegment(event.taskId)}`,
          title: event.description,
          state: "working",
          msg: event.agent,
        });
        break;
      case "subagent_update": {
        const task = this.tasks.get(event.taskId);
        if (task?.state === "working" && event.toolName !== undefined)
          task.msg = run.runningTool(event.toolName);
        break;
      }
      case "subagent_end": {
        const task = this.tasks.get(event.taskId);
        if (task === undefined) break;
        const s = event.status;
        task.state =
          s === "completed" ? "done" : s === "aborted" || s === "interrupted" ? "idle" : "error";
        delete task.msg;
        break;
      }
      default:
        return;
    }
    this.sync();
  }

  /** 用户按键：已看到的 done / error 回到 idle。 */
  acknowledge(): void {
    if (this.running || this.outcome === undefined || this.outcome.state === "idle") return;
    this.outcome = { state: "idle" };
    this.sync();
  }

  /** 当前根记录（测试也用）。 */
  root(): ProgramStatusReport {
    const pending = [...this.approvals.values()].at(-1);
    if (pending !== undefined) return blocked("permission", pending.msg);
    if (this.plan !== undefined) return blocked("question", this.plan);
    if (this.auth !== undefined) return blocked("auth", this.auth);
    if (this.running)
      return { state: "working", ...(this.activity !== undefined ? { msg: this.activity } : {}) };
    return this.outcome ?? { state: "idle" };
  }

  /** 写出全部记录（发射器同值去重）。 */
  sync(): void {
    this.emitter.report(this.root());
    for (const task of this.tasks.values())
      this.emitter.report({
        id: task.id,
        state: task.state,
        title: task.title,
        ...(task.state === "blocked" ? { kind: "permission" as const } : {}),
        ...(task.msg !== undefined ? { msg: task.msg } : {}),
      });
  }

  private outcomeOf(stopReason: string): Outcome {
    if (stopReason === "aborted") return { state: "idle" };
    if (stopReason !== "error") return { state: "done" };
    const text = flat(this.lastError ?? "error", 200);
    if (AUTH_EXPIRED.test(text)) this.auth = text;
    return { state: "error", msg: text };
  }

  private dropTask(key: string): void {
    const task = this.tasks.get(key);
    this.tasks.delete(key);
    if (task !== undefined) this.emitter.report({ id: task.id, state: "clear" });
  }

  private reset(): void {
    this.running = false;
    this.approvals.clear();
    this.plan = this.auth = this.outcome = this.lastError = this.activity = undefined;
    for (const key of [...this.tasks.keys()]) this.dropTask(key);
  }
}

function blocked(kind: BlockedKind, text: string): ProgramStatusReport {
  return { state: "blocked", kind, msg: text };
}

export interface ProgramStatusUi {
  /** 包一层会话事件处理：先更新状态记录，再交给原处理。 */
  wrap(handler: (event: SessionEvent) => void): (event: SessionEvent) => void;
  /** 终端进入 raw 模式之后：检测（auto）并写初始 idle。 */
  start(): void;
  /** 退出交互模式前：清掉全部记录、停计时器。 */
  exit(): void;
}

/**
 * 交互模式装配。缺省只在真实终端（没有注入 `terminal`）启用；测试注入终端时给了 `programStatus` 才启用，
 * 其余情况与 `ui.programStatus: "off"` 一样全部空操作。
 */
export function programStatusUi(deps: {
  tui: TUI;
  runtime: Runtime;
  env: NodeJS.ProcessEnv;
  options: { terminal?: unknown; programStatus?: ProgramStatusOptions };
  cwd(): string | undefined;
}): ProgramStatusUi {
  const { terminal, programStatus } = deps.options;
  const mode = deps.runtime.config.ui?.programStatus ?? "auto";
  if ((terminal !== undefined && programStatus === undefined) || mode === "off")
    return { wrap: (handler) => handler, start: () => undefined, exit: () => undefined };
  const emitter = new ProgramStatusEmitter({
    write: (data) => deps.tui.terminal.write(data),
    mode,
    env: deps.env,
    app: "ama",
    ...programStatus,
  });
  const tracker = new ProgramStatusTracker(emitter, deps.cwd);
  deps.tui.addInputListener((data) => {
    if (emitter.handleInput(data)) return true;
    tracker.acknowledge();
    return false;
  });
  return {
    wrap: (handler) => (event) => {
      tracker.onEvent(event);
      handler(event);
    },
    start: () => {
      emitter.start();
      tracker.sync();
    },
    exit: () => {
      emitter.report({ state: "clear" });
      emitter.dispose();
    },
  };
}
