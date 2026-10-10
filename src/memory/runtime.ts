/**
 * 一次运行的记忆状态（docs/history/wave6-plan.md §3）。[W6-M]
 *
 * 组装根（cli/compose-memory.ts）在 `memory.enabled` 时建一个，交给工具（tool.ts）、系统节与 `/memory`。
 * 没开启时根本不建：不读盘、不注册工具、不渲染节（请求体逐字节不变）。
 */

import type { MemoryEntry } from "./index.js";
import type { MemoryScope } from "./paths.js";
import { renderMemorySection } from "./section.js";
import type { MemoryStore } from "./store.js";

export type MemorySubagentMode = "off" | "read";

/** 启用但没装上的作用域（界面提示用）。 */
export interface SkippedScope {
  scope: "project";
  reason: "untrusted";
}

export class MemoryRuntime {
  /** `/memory on|off`：本会话是否允许写（缺省允许，写命令仍走权限审批）。 */
  writesEnabled = true;

  constructor(
    readonly store: MemoryStore,
    readonly options: {
      subagents: MemorySubagentMode;
      /** 嵌入宿主（profile / SDK 给了 dir）：只有 workspace 作用域。 */
      embedded: boolean;
      skipped?: readonly SkippedScope[];
      /** 项目作用域对应的项目根。 */
      projectRoot?: string;
    },
  ) {}

  get scopes(): MemoryScope[] {
    return this.store.scopes();
  }

  get subagents(): MemorySubagentMode {
    return this.options.subagents;
  }

  get skipped(): readonly SkippedScope[] {
    return this.options.skipped ?? [];
  }

  indexes(): Partial<Record<MemoryScope, MemoryEntry[]>> {
    const out: Partial<Record<MemoryScope, MemoryEntry[]>> = {};
    for (const scope of this.scopes) out[scope] = this.store.entries(scope);
    return out;
  }

  /** 当前磁盘状态渲染出的 `memory` 节。 */
  renderSection(): string | undefined {
    return renderMemorySection(this.indexes(), this.store.limits.indexMaxBytes);
  }
}
