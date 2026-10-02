/**
 * 会话扩展的组装表（docs/wave5-plan.md §10.1，D30）。[W5-C0]
 *
 * 唯一允许多个批次各加一行的文件：每个批次在 `composeExtensions` 的数组里追加**一行**自己的工厂，
 * 实现放在各自文件（`src/agent/session-<名>.ts` 等）。表顺序即调用顺序：
 * - `beforePrompts`：靠前的先追加（plan 模式说明排在提醒之前）；
 * - `wrapStream`：靠前的离协议层近，缓存控制器始终在最外层；
 * - 其余钩子按表顺序。
 *
 * 写法（工厂每个会话实例各调一次；不想装进 task 子会话就按 depth 返回 undefined）：
 *
 * ```ts
 * // src/agent/session-telemetry.ts [W5-A]
 * export function createTelemetryExtension(deps: { now?(): number }): SessionExtension { … }
 * // 本文件，数组里加一行：
 * ({ core }) => (core.depth > 0 ? undefined : createTelemetryExtension({})),
 * ```
 *
 * 配置从 `deps.assembly.config` 读（键与校验已在 config/schema-w5.ts，C0 统一加好）。
 */

import type { SessionExtensionFactory } from "../agent/session-extensions.js";
import type { SessionAssembly } from "./deps.js";
import { createExternalStatsExtension } from "../drivers/store.js";

export interface ComposeExtensionDeps {
  /** 第 14 步的装配材料：config、paths、mode、unattended、host、overrides 等。 */
  readonly assembly: SessionAssembly;
  readonly env: NodeJS.ProcessEnv;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export function composeExtensions(_deps: ComposeExtensionDeps): SessionExtensionFactory[] {
  return [
    // 各批次在下面约定的位置各加一行（顺序有意义，见文件头）：
    // [W5-F]  createPlanExtension(...)
    // [W5-H2] createRemindersExtension(...), createLimitsExtension(...)
    // [W5-I]  createImageBudgetExtension(...)
    // [W5-A]  createTelemetryExtension(...)
    // [W5-E] 外部 Agent 记账 → SessionStats.external（只主会话）
    ({ core }) =>
      core.depth > 0 ? undefined : createExternalStatsExtension(() => core.manager.branch()),
  ];
}
