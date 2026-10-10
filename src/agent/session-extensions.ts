/**
 * 会话扩展点（docs/history/wave5-plan.md §10.1，D30）。[W5-C0]
 *
 * 第五波的遥测、计划、提醒、图片预算、预算上限等都以扩展实现在各自文件，`session.ts` 只留调用点：
 *
 * | 钩子             | 调用点                                                                                  |
 * | ---------------- | --------------------------------------------------------------------------------------- |
 * | `beforePrompts`  | `runPrompt` 组装好 prompts（用户消息 + Hook additionalContext）、阈值压缩与检查点之后， |
 * |                  | 按表顺序调用；返回的消息**追加在 prompts 之后**（只能是 custom_message，不得改已有消息） |
 * | `wrapStream`     | 会话构造时按表顺序包流：表中靠前的离协议层近；缓存控制器始终在最外层（看到最终请求）   |
 * | `onEvent`        | 每个 `SessionEvent` 广播给订阅者之后                                                    |
 * | `onAgentSettled` | `agent_settled` 发出之后、本周期结束（`waitForIdle` resolve）之前 await                  |
 * | `contributeStats`| `getStats()` 末尾，就地补 `SessionStats` 的字段                                         |
 * | `dispose`        | 会话 dispose 时                                                                         |
 *
 * 约束：
 * - **缓存前缀**（design §9.1）：扩展不得改 system 节与工具表、不得改已有消息；只能在尾部追加。
 * - 选项里放的是**工厂**（`SessionExtensionFactory`），每个会话实例（主会话、fork、task 子会话）
 *   各调一次得到自己的扩展实例；工厂按 `ctx.core.depth` 决定子会话要不要装（返回 undefined 即不装）。
 *   工厂在会话构造中途调用：只可读 `core.options / depth / cwd / manager`，不要 emit 或请求模型。
 * - 钩子抛错不影响会话：同步钩子的异常记 warn 日志后忽略；`beforePrompts` / `onAgentSettled`
 *   的异常同样记日志、按「无追加」处理。
 * - 会话级诊断（#183）：构造时顺带把 `core.manager` 的告警接到 `core.log`（每个会话实例一次）。
 * - `onAgentSettled` 不要等待人工输入（计划审批等）：需要等待的流程自行异步进行，之后用
 *   `prompt / followUp` 开新回合。
 */

import type { AgentMessage } from "../session/types.js";
import type { StreamFn } from "./loop.js";
import type { SessionCore } from "./session-core.js";
import type { SessionEvent, SessionStats } from "./types.js";

export interface SessionExtensionContext {
  /** appendEntry / reloadMessages / emit / manager / model() / cache / options / depth。 */
  readonly core: SessionCore;
}

export interface SessionExtension {
  readonly id: string;
  /** 新回合 prompts 投递前；返回要追加在 prompts 之后的消息（只能 custom_message）。 */
  beforePrompts?(
    ctx: SessionExtensionContext,
    prompts: readonly AgentMessage[],
  ): Promise<AgentMessage[]> | AgentMessage[];
  wrapStream?(stream: StreamFn): StreamFn;
  onEvent?(event: SessionEvent): void;
  onAgentSettled?(ctx: SessionExtensionContext): Promise<void> | void;
  contributeStats?(stats: SessionStats): void;
  dispose?(): void;
}

/** 每个会话实例调一次；返回 undefined = 本会话不装（例如子会话）。 */
export type SessionExtensionFactory = (
  ctx: SessionExtensionContext,
) => SessionExtension | undefined;

type Log = (level: "warn", message: string) => void;

/** 会话持有的扩展集合：把各钩子的遍历、顺序与异常隔离集中在这里，session.ts 只调一行。 */
export class SessionExtensions {
  private readonly list: readonly SessionExtension[];
  private readonly ctx: SessionExtensionContext;

  constructor(core: SessionCore, factories: readonly SessionExtensionFactory[] | undefined) {
    this.ctx = { core };
    const list: SessionExtension[] = [];
    for (const factory of factories ?? []) {
      const extension = guard(core.log.bind(core), "factory", () => factory(this.ctx));
      if (extension !== undefined) list.push(extension);
    }
    this.list = list;
    // 会话级诊断（#183）：manager 的告警（图片读不回）走会话日志；动态读 options.log，TUI 换掉也生效
    core.manager.setWarn((message) => core.log("warn", message));
  }

  get size(): number {
    return this.list.length;
  }

  ids(): string[] {
    return this.list.map((extension) => extension.id);
  }

  /** 表中靠前的离协议层近；调用方再把结果交给缓存控制器包在最外层。 */
  wrapStream(stream: StreamFn): StreamFn {
    let wrapped = stream;
    for (const extension of this.list) {
      const next = extension.wrapStream?.(wrapped);
      if (next !== undefined) wrapped = next;
    }
    return wrapped;
  }

  async beforePrompts(prompts: readonly AgentMessage[]): Promise<AgentMessage[]> {
    const added: AgentMessage[] = [];
    for (const extension of this.list) {
      if (extension.beforePrompts === undefined) continue;
      try {
        added.push(...(await extension.beforePrompts(this.ctx, [...prompts, ...added])));
      } catch (error) {
        this.warn(extension, "beforePrompts", error);
      }
    }
    return added;
  }

  onEvent(event: SessionEvent): void {
    for (const extension of this.list) {
      if (extension.onEvent === undefined) continue;
      try {
        extension.onEvent(event);
      } catch (error) {
        this.warn(extension, "onEvent", error);
      }
    }
  }

  async onAgentSettled(): Promise<void> {
    for (const extension of this.list) {
      if (extension.onAgentSettled === undefined) continue;
      try {
        await extension.onAgentSettled(this.ctx);
      } catch (error) {
        this.warn(extension, "onAgentSettled", error);
      }
    }
  }

  contributeStats(stats: SessionStats): SessionStats {
    for (const extension of this.list) {
      if (extension.contributeStats === undefined) continue;
      try {
        extension.contributeStats(stats);
      } catch (error) {
        this.warn(extension, "contributeStats", error);
      }
    }
    return stats;
  }

  dispose(): void {
    for (const extension of this.list) {
      try {
        extension.dispose?.();
      } catch (error) {
        this.warn(extension, "dispose", error);
      }
    }
  }

  private warn(extension: SessionExtension, hook: string, error: unknown): void {
    this.ctx.core.log("warn", `extension ${extension.id} failed in ${hook}: ${String(error)}`);
  }
}

function guard<T>(log: Log, hook: string, run: () => T | undefined): T | undefined {
  try {
    return run();
  } catch (error) {
    log("warn", `extension ${hook} failed: ${String(error)}`);
    return undefined;
  }
}
