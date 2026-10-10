/**
 * 外部 Agent 并发池（docs/history/wave5-plan.md §5.4 并发）。[W5-E]
 *
 * 总并发 `agents.maxConcurrent`（缺省 3）+ 每个 Agent 的上限 `agents.<id>.maxConcurrent`
 * （claude 缺省 2：订阅有速率限制）；超出排队（先来先得），排队可被 abort。与 ama 自己的
 * `SubagentPool`（子会话）分开计数。
 */

import { AmaError } from "../errors.js";
import { agentEntry, type AgentsConfig } from "../config/types-w5.js";

export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_PER_AGENT: Readonly<Record<string, number>> = { claude: 2 };

interface Waiter {
  agentId: string;
  grant(release: () => void): void;
}

export class DriverPool {
  private readonly active = new Map<string, number>();
  private total = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly maxTotal: number = DEFAULT_MAX_CONCURRENT,
    private readonly perAgent: (agentId: string) => number | undefined = () => undefined,
  ) {}

  running(agentId?: string): number {
    return agentId === undefined ? this.total : (this.active.get(agentId) ?? 0);
  }

  queued(): number {
    return this.queue.length;
  }

  private limitFor(agentId: string): number {
    return this.perAgent(agentId) ?? this.maxTotal;
  }

  private canRun(agentId: string): boolean {
    return this.total < this.maxTotal && this.running(agentId) < this.limitFor(agentId);
  }

  private take(agentId: string): () => void {
    this.total += 1;
    this.active.set(agentId, this.running(agentId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      this.active.set(agentId, this.running(agentId) - 1);
      this.drain();
    };
  }

  private drain(): void {
    for (let i = 0; i < this.queue.length;) {
      const waiter = this.queue[i]!;
      if (this.canRun(waiter.agentId)) {
        this.queue.splice(i, 1);
        waiter.grant(this.take(waiter.agentId));
      } else i++;
    }
  }

  /** 拿到一个名额（返回释放函数）；abort 时离开队列并以 `aborted` 失败。 */
  acquire(agentId: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(abortedError());
    // 有空位时，排队的只可能是卡在各自上限上的其它 Agent：同一 Agent 已有人排队就跟在后面
    if (this.canRun(agentId) && !this.queue.some((w) => w.agentId === agentId))
      return Promise.resolve(this.take(agentId));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const at = this.queue.indexOf(waiter);
        if (at >= 0) this.queue.splice(at, 1);
        reject(abortedError());
      };
      const waiter: Waiter = {
        agentId,
        grant: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }
}

function abortedError(): AmaError {
  return new AmaError("aborted", "external agent was interrupted while queued");
}

/** 按配置建池（`agents.maxConcurrent`、`agents.<id>.maxConcurrent`）。 */
export function poolFromConfig(config: AgentsConfig | undefined): DriverPool {
  const total =
    typeof config?.maxConcurrent === "number" && config.maxConcurrent > 0
      ? config.maxConcurrent
      : DEFAULT_MAX_CONCURRENT;
  return new DriverPool(total, (agentId) => {
    const own = agentEntry(config, agentId)?.maxConcurrent;
    return typeof own === "number" && own > 0 ? own : DEFAULT_PER_AGENT[agentId];
  });
}
