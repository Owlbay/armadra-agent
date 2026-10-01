/**
 * 有状态 Agent（设计 §4.1–§4.3）：持有上下文消息、两条队列、当前 run，发 agent_start / agent_end。[B2]
 *
 * - `run(prompts)`：运行中再调用 → `AmaError{code:"busy"}`；空 prompts = continue（末条须能转成
 *   user / toolResult）。返回 RunOutcome；`agent_end.willRetry` 由 `onRunEnd` 决定（会话层重试 /
 *   溢出恢复在 agent_end 之前就要知道是否会重试）。
 * - 监听器按订阅顺序被 await，计入本 run 的收尾；监听器抛错只记录不中断。
 * - `abort()` 只中断当前 run（不清队列）；`waitForIdle()` 在 run 与 agent_end 监听器都结束后 resolve。
 * - 消息在 `message_end` 时进入 `messages`；会话层可在 run 之间（或 run 中、请求之前）整体替换。
 */

import type { Model, ModelThinkingLevel, StreamOptions } from "../ai/types.js";
import { AmaError } from "../errors.js";
import type { AgentMessage } from "../session/types.js";
import {
  failureMessage,
  runLoop,
  type LoopCallbacks,
  type RunOutcome,
  type StreamFn,
} from "./loop.js";
import { PendingMessageQueue } from "./queue.js";
import type { ToolRunnerOptions } from "./tool-runner.js";
import type { QueueMode, SessionEvent } from "./types.js";

export type AgentListener = (event: SessionEvent) => void | Promise<void>;

export interface AgentOptions {
  hooks: LoopCallbacks;
  stream: StreamFn;
  getModel(): Model;
  getThinkingLevel(): ModelThinkingLevel;
  streamOptions?(model: Model): Promise<Partial<StreamOptions>> | Partial<StreamOptions>;
  beforeRequest?(signal: AbortSignal): Promise<void>;
  tools: ToolRunnerOptions;
  messages?: AgentMessage[];
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  /** 监听器抛错时的记录口。 */
  onListenerError?(error: unknown, event: SessionEvent): void;
}

export interface AgentRunOptions {
  /** 外部取消（会话级 AbortController）；与本 run 自己的控制器联动。 */
  signal?: AbortSignal;
  skipInitialSteering?: boolean;
  /** 在 agent_end 之前调用，返回是否会重试（写进 agent_end.willRetry）。 */
  onRunEnd?(outcome: RunOutcome): boolean | Promise<boolean>;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

export class Agent {
  messages: AgentMessage[];
  readonly steeringQueue: PendingMessageQueue;
  readonly followUpQueue: PendingMessageQueue;
  private readonly listeners = new Set<AgentListener>();
  private readonly options: AgentOptions;
  private active: ActiveRun | undefined;

  constructor(options: AgentOptions) {
    this.options = options;
    this.messages = options.messages?.slice() ?? [];
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
  }

  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  get signal(): AbortSignal | undefined {
    return this.active?.controller.signal;
  }

  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  abort(): void {
    this.active?.controller.abort();
  }

  waitForIdle(): Promise<void> {
    return this.active?.promise ?? Promise.resolve();
  }

  private async emit(event: SessionEvent): Promise<void> {
    if (event.type === "message_end") this.messages.push(event.message);
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.options.onListenerError?.(error, event);
      }
    }
  }

  async run(
    prompts: readonly AgentMessage[],
    runOptions: AgentRunOptions = {},
  ): Promise<RunOutcome> {
    if (this.active !== undefined) {
      throw new AmaError("busy", "agent is already running; use steer() or followUp()");
    }
    const controller = new AbortController();
    const parent = runOptions.signal;
    const onParentAbort = (): void => controller.abort();
    if (parent !== undefined) {
      if (parent.aborted) controller.abort();
      else parent.addEventListener("abort", onParentAbort, { once: true });
    }
    let resolveIdle: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    this.active = { controller, promise };
    const options = this.options;
    const emit = (event: SessionEvent): Promise<void> => this.emit(event);
    let outcome: RunOutcome;
    try {
      await emit({ type: "agent_start" });
      try {
        const loopOptions =
          runOptions.skipInitialSteering === true ? { skipInitialSteering: true } : {};
        const config = {
          hooks: options.hooks,
          getSteeringMessages: () => this.steeringQueue.drain(),
          getFollowUpMessages: () => this.followUpQueue.drain(),
          getMessages: () => this.messages,
          getModel: options.getModel,
          getThinkingLevel: options.getThinkingLevel,
          stream: options.stream,
          tools: options.tools,
          emit,
          ...(options.streamOptions === undefined ? {} : { streamOptions: options.streamOptions }),
          ...(options.beforeRequest === undefined ? {} : { beforeRequest: options.beforeRequest }),
        };
        outcome = await runLoop(prompts, config, controller.signal, loopOptions);
      } catch (error) {
        const aborted = controller.signal.aborted;
        const message = failureMessage(
          options.getModel(),
          aborted ? "aborted" : "error",
          error instanceof Error ? error.message : String(error),
        );
        await emit({ type: "message_start", message });
        await emit({ type: "message_end", message });
        await emit({ type: "turn_end", message, toolResults: [] });
        outcome = {
          lastAssistant: message,
          stopReason: message.stopReason,
          newMessages: [message],
        };
      }
      let willRetry = false;
      try {
        willRetry = (await runOptions.onRunEnd?.(outcome)) ?? false;
      } catch {
        willRetry = false;
      }
      await emit({ type: "agent_end", stopReason: outcome.stopReason, willRetry });
      return outcome;
    } finally {
      parent?.removeEventListener("abort", onParentAbort);
      this.active = undefined;
      resolveIdle();
    }
  }
}
