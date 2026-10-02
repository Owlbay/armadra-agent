/**
 * 宿主注入的 runner（`HostApi.runners.provide` 的底座，docs/wave5-plan.md §5.5，D17）。[W5-E → W5-EG]
 *
 * 一个宿主适配器一份（host/api-impl.ts 建，经 {@link ExternalAgents} 的 `hostRunners` 选项交给每个
 * 主会话）：宿主可以在 `create()` 里或之后任何时候 `provide`，同名替换；返回的函数注销。
 * `onChange` 供 `/agents` / RPC `get_agents` 的缓存刷新。
 */

import { AmaError } from "../errors.js";
import type { HostRunner } from "../host/types.js";
import { msg } from "../i18n/index.js";

export class HostRunnerRegistry {
  private readonly runners = new Map<string, HostRunner>();
  private readonly listeners = new Set<() => void>();

  provide(runner: HostRunner): () => void {
    if (typeof runner?.id !== "string" || runner.id === "" || typeof runner.start !== "function")
      throw new AmaError("invalid_arguments", msg().drivers.host.runnerNeedsIdStart);
    this.runners.set(runner.id, runner);
    this.changed();
    return () => {
      if (this.runners.get(runner.id) !== runner) return;
      this.runners.delete(runner.id);
      this.changed();
    };
  }

  get(id: string): HostRunner | undefined {
    return this.runners.get(id);
  }

  list(): HostRunner[] {
    return [...this.runners.values()];
  }

  /** 注入 / 注销时回调；返回取消订阅。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // 监听方出错不影响宿主
      }
    }
  }
}
