/**
 * HostApi 实现（设计 §6.2）。[B5]
 *
 * 核心不知道宿主：这里把 HostApi 的各个面接到注入的依赖上——工具注册表（B3）、会话访问器
 * （B2 组装后才可用，所以全部是惰性函数）、指令收集、broker 槽、sendUser、UI 通知。
 * 事件总线 `AgentEventBus` 由 bootstrap 创建并交给 AgentSession 发事件；处理器只观察，
 * 抛错记日志；`emit` 等待全部处理器（`session_shutdown` 需要被 await）。
 */

import { AmaError } from "../errors.js";
import { AMA_VERSION } from "../version.js";
import type {
  AgentEventName,
  AgentEvents,
  ApprovalBroker,
  HostAdapter,
  HostAdapterHandle,
  HostApi,
  HostMode,
  InstructionSource,
} from "./types.js";
import { HOST_API_VERSION } from "./types.js";
import type { ToolDefinition, ToolRegistryApi } from "../tools/types.js";
import type { WarmingDecisionHandler } from "../ai/cache/types.js";

export type HostNotify = (message: string, level: "info" | "warn" | "error") => void;

export type HostLogLevel = "debug" | "info" | "warn" | "error";
export type HostLogger = (level: HostLogLevel, message: string, detail?: unknown) => void;

type Handler<E extends AgentEventName> = (event: AgentEvents[E]) => void | Promise<void>;

/** 进程内事件总线（宿主观察 AgentEvents）。 */
export class AgentEventBus {
  private readonly handlers = new Map<AgentEventName, Set<Handler<AgentEventName>>>();
  private readonly log: HostLogger;

  constructor(log: HostLogger = () => undefined) {
    this.log = log;
  }

  on<E extends AgentEventName>(name: E, handler: Handler<E>): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler as Handler<AgentEventName>);
    this.handlers.set(name, set);
    return () => {
      set.delete(handler as Handler<AgentEventName>);
    };
  }

  listenerCount(name: AgentEventName): number {
    return this.handlers.get(name)?.size ?? 0;
  }

  /** 依次调用处理器并等待；处理器异常记日志后继续。 */
  async emit<E extends AgentEventName>(name: E, event: AgentEvents[E]): Promise<void> {
    const set = this.handlers.get(name);
    if (set === undefined || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        await handler(event);
      } catch (error) {
        this.log("error", `宿主事件处理器异常（${name}）`, error);
      }
    }
  }
}

/** 惰性会话访问器（AgentSession 组装前调用返回占位值）。 */
export interface HostSessionAccess {
  id(): string;
  file(): string | undefined;
  cwd(): string;
  model(): { provider: string; id: string } | undefined;
}

export interface HostApiDeps {
  mode: HostMode;
  env?: Readonly<NodeJS.ProcessEnv>;
  session: HostSessionAccess;
  tools: ToolRegistryApi;
  bus: AgentEventBus;
  /** 运行中按 steer 入队；会话未组装时抛错。 */
  sendUser(text: string, origin: string): Promise<"started" | "queued">;
  /** 交互 / line 模式的 UI 通知；未提供时写 stderr。模式层也可晚绑定：`binding.setNotify()`。 */
  notify?: HostNotify;
  /** 状态变化回调（TUI 状态栏刷新）。 */
  onStatus?: (key: string, text: string | undefined) => void;
  log?: HostLogger;
  /** stderr 写入（测试注入）。 */
  stderr?: (text: string) => void;
}

/** createHostApi 的产物：api 交给适配器，其余给 bootstrap / AgentSession。 */
export interface HostApiBinding {
  readonly api: HostApi;
  /** 适配器追加的指令（系统提示 host 节，按追加顺序）。 */
  readonly instructions: readonly InstructionSource[];
  /** 适配器设置的 broker（最后一次 setBroker 生效）。 */
  broker(): ApprovalBroker | undefined;
  /** 适配器注册的工具名。 */
  readonly registeredTools: readonly string[];
  /** 适配器禁用的工具名。 */
  readonly disabledTools: readonly string[];
  status(): ReadonlyMap<string, string>;
  /** 绑定成 Runtime 持有的 handle。 */
  handle(adapter: HostAdapter, source: string): HostAdapterHandle;
  /**
   * 晚绑定 UI 通知（模式层在 TUI / RPC 就绪后调用）；覆盖构造时的 `deps.notify`，
   * 传 undefined 恢复为构造时的值（未提供则写 stderr）。
   */
  setNotify(fn?: HostNotify): void;
  /** [W3-C0] 宿主经 `cache.onWarmingDecision` 注册的否决钩子（最后注册且未注销的那个）。 */
  warmingDecider(): WarmingDecisionHandler | undefined;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;

function validateTool(tool: ToolDefinition): void {
  if (typeof tool !== "object" || tool === null) {
    throw new AmaError("invalid_arguments", "tools.register：工具定义应为对象");
  }
  if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
    throw new AmaError("invalid_arguments", `tools.register：工具名不合法：${String(tool.name)}`);
  }
  if (typeof tool.execute !== "function") {
    throw new AmaError("invalid_arguments", `tools.register：${tool.name} 缺少 execute()`);
  }
  if (!["read", "write", "execute"].includes(tool.permission)) {
    throw new AmaError("invalid_arguments", `tools.register：${tool.name} 的 permission 不合法`);
  }
}

export function createHostApi(deps: HostApiDeps): HostApiBinding {
  const instructions: InstructionSource[] = [];
  const registeredTools: string[] = [];
  const disabledTools: string[] = [];
  const status = new Map<string, string>();
  let broker: ApprovalBroker | undefined;
  const warmingHandlers: WarmingDecisionHandler[] = [];
  let notify: HostNotify | undefined = deps.notify;
  const writeErr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const log: HostLogger =
    deps.log ??
    ((level, message) => {
      if (level === "warn" || level === "error") writeErr(`ama: [host] ${message}\n`);
    });

  const api: HostApi = Object.freeze({
    version: HOST_API_VERSION,
    agent: Object.freeze({ name: "ama" as const, version: AMA_VERSION }),
    env: Object.freeze({ ...(deps.env ?? process.env) }),
    mode: deps.mode,
    session: Object.freeze({
      id: () => deps.session.id(),
      file: () => deps.session.file(),
      cwd: () => deps.session.cwd(),
      model: () => deps.session.model(),
    }),
    tools: Object.freeze({
      register(tool: ToolDefinition): void {
        validateTool(tool);
        if (deps.tools.get(tool.name) !== undefined) {
          throw new AmaError("tool_exists", `tools.register：工具 ${tool.name} 已存在`);
        }
        deps.tools.register(tool, "host");
        registeredTools.push(tool.name);
      },
      disable(name: string): void {
        deps.tools.disable(name);
        if (!disabledTools.includes(name)) disabledTools.push(name);
      },
      list: () => deps.tools.list(),
    }),
    instructions: Object.freeze({
      add(source: InstructionSource): void {
        if (source.kind === "file" && typeof source.path !== "string") {
          throw new AmaError("invalid_arguments", "instructions.add：file 需要 path");
        }
        if (source.kind === "text" && typeof source.text !== "string") {
          throw new AmaError("invalid_arguments", "instructions.add：text 需要 text");
        }
        instructions.push({ ...source });
      },
    }),
    events: Object.freeze({
      on: <E extends AgentEventName>(name: E, handler: Handler<E>) => deps.bus.on(name, handler),
    }),
    approvals: Object.freeze({
      setBroker(next: ApprovalBroker): void {
        if (typeof next?.ask !== "function") {
          throw new AmaError("invalid_arguments", "approvals.setBroker：broker 需要 ask()");
        }
        broker = next;
      },
    }),
    messages: Object.freeze({
      sendUser: (text: string, origin?: string) => deps.sendUser(text, origin ?? "host"),
    }),
    ui: Object.freeze({
      notify(message: string, level: "info" | "warn" | "error" = "info"): void {
        // 交互 / line 由 UI 显示；rpc 由模式转成事件；print（或未注入）写 stderr。
        if (notify !== undefined && deps.mode !== "print") {
          notify(message, level);
          return;
        }
        writeErr(`ama: [host${level === "info" ? "" : ` ${level}`}] ${message}\n`);
      },
      setStatus(key: string, text?: string): void {
        if (text === undefined || text === "") status.delete(key);
        else status.set(key, text);
        deps.onStatus?.(key, text);
      },
    }),
    log,
    cache: Object.freeze({
      onWarmingDecision(handler: WarmingDecisionHandler): () => void {
        if (typeof handler !== "function") {
          throw new AmaError("invalid_arguments", "cache.onWarmingDecision：需要函数");
        }
        warmingHandlers.push(handler);
        return () => {
          const index = warmingHandlers.lastIndexOf(handler);
          if (index >= 0) warmingHandlers.splice(index, 1);
        };
      },
    }),
  });

  return {
    api,
    instructions,
    broker: () => broker,
    registeredTools,
    disabledTools,
    status: () => status,
    handle(adapter: HostAdapter, source: string): HostAdapterHandle {
      return { adapter, api, source, status: () => status };
    },
    setNotify(fn?: HostNotify): void {
      notify = fn ?? deps.notify;
    },
    warmingDecider: () => warmingHandlers.at(-1),
  };
}
