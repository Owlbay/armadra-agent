/**
 * codemode 三种模式（设计 §5.5 模式表、§5.6；实施计划 §9 修正）。[B10]
 *
 * | 模式   | 模型看到的工具                                                             |
 * | ------ | -------------------------------------------------------------------------- |
 * | `off`  | 不注册 codemode（工厂返回 undefined）                                       |
 * | `on`   | 预设的工具 + codemode；其它工具描述末尾加一行「也可在 codemode 脚本里调用」 |
 * | `only` | 只有 codemode（宿主 / SDK 工具也不直接暴露）；其它工具的声明列在它的描述里 |
 *
 * 活动集由 B6 的 `resolvePreset` 决定（`only` → `["codemode"]`）；这里补两件事：`on` 模式下的描述
 * 追加（在注册前包一层，描述在会话开始时就确定、字节稳定）与 `only` 模式的独占活动集
 * （`PresetToolRegistry.setPresetTools(names, { exclusive: true })`）。
 */

import type { CodemodeMode } from "../config/types.js";
import { CODEMODE_TOOL, type PresetResolution, type PresetToolRegistry } from "../tools/presets.js";
import type { ToolDefinition } from "../tools/types.js";

export function codemodeHint(name: string): string {
  return `Also callable inside codemode scripts as tools.${name}(args).`;
}

/** 复制工具（保留 getter 与方法），描述末尾追加一行 codemode 提示。 */
export function withCodemodeHint<I>(tool: ToolDefinition<I>): ToolDefinition<I> {
  const copy = Object.create(Object.getPrototypeOf(tool) as object | null, {
    ...Object.getOwnPropertyDescriptors(tool),
  }) as ToolDefinition<I>;
  Object.defineProperty(copy, "description", {
    value: `${tool.description}\n${codemodeHint(tool.name)}`,
    enumerable: true,
    writable: false,
    configurable: true,
  });
  return copy;
}

/** 注册前的包装：`on` 模式给 codemode 以外的工具加提示，其它模式原样返回。 */
export function decorateForMode(
  mode: CodemodeMode,
): <I>(tool: ToolDefinition<I>) => ToolDefinition<I> {
  if (mode !== "on") return (tool) => tool;
  return (tool) => (tool.name === CODEMODE_TOOL ? tool : withCodemodeHint(tool));
}

/** 把预设结果落到注册表：`only` 时活动集独占（宿主 / SDK 工具也只能在脚本里调用）。 */
export function applyCodemodeMode(
  registry: PresetToolRegistry,
  resolution: Pick<PresetResolution, "builtin" | "codemode">,
): void {
  registry.setPresetTools(resolution.builtin, { exclusive: resolution.codemode === "only" });
}
