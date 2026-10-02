/**
 * codemode 三种模式（设计 §5.5 模式表、§5.6；实施计划 §9 修正）。[B10]
 *
 * | 模式   | 模型看到的工具                                                             |
 * | ------ | -------------------------------------------------------------------------- |
 * | `off`  | 不注册 codemode（工厂返回 undefined）                                       |
 * | `on`   | 预设的工具 + codemode；codemode 描述一行列出可在脚本里调用的直接工具       |
 * | `only` | 只有 codemode（宿主 / SDK 工具也不直接暴露）；其它工具的声明列在它的描述里 |
 *
 * 活动集由 B6 的 `resolvePreset` 决定（`only` → `["codemode"]`）；这里落 `only` 模式的独占活动集
 * （`PresetToolRegistry.setPresetTools(names, { exclusive: true })`）。`on` 模式不再给其它工具的描述
 * 追加提示：直接工具的描述与 off 模式逐字节相同，codemode 描述里一行列出它们（codemode/tool.ts）。
 */

import { type PresetResolution, type PresetToolRegistry } from "../tools/presets.js";

/** 把预设结果落到注册表：`only` 时活动集独占（宿主 / SDK 工具也只能在脚本里调用）。 */
export function applyCodemodeMode(
  registry: PresetToolRegistry,
  resolution: Pick<PresetResolution, "builtin" | "codemode">,
): void {
  registry.setPresetTools(resolution.builtin, { exclusive: resolution.codemode === "only" });
}
