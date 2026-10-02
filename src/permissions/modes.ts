/**
 * 六种权限模式的显示名、一行说明、界面顺序与 Shift+Tab 循环（§7.4）。
 *
 * 显示名用英文（与常见编码 Agent 的叫法一致），说明随界面语言（`msg().permissions`）。界面顺序就是选择器里
 * 数字快捷键 1–6 的顺序；`allowlist` 不在 Shift+Tab 循环里，只能显式选。
 */

import { msg, type Catalog } from "../i18n/index.js";
import { PERMISSION_MODES_STRICT_FIRST, type PermissionMode } from "./types.js";

export interface PermissionModeInfo {
  label: string;
  description: string;
}

/** 说明随界面语言（取用时求值，不在 import 时定死）。 */
function info(
  label: string,
  key: keyof Catalog["permissions"]["modeDescription"],
): PermissionModeInfo {
  return {
    label,
    get description() {
      return msg().permissions.modeDescription[key];
    },
  };
}

export const PERMISSION_MODE_INFO: Readonly<Record<PermissionMode, PermissionModeInfo>> = {
  default: info("Manual", "default"),
  "auto-edit": info("Accept edits", "autoEdit"),
  plan: info("Plan", "plan"),
  auto: info("Auto", "auto"),
  "full-auto": info("Bypass permissions", "fullAuto"),
  allowlist: info("Allowlist only", "allowlist"),
};

/** 选择器顺序（数字快捷键 1–6）。 */
export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = [
  "default",
  "auto-edit",
  "plan",
  "auto",
  "full-auto",
  "allowlist",
];

/** Shift+Tab 循环顺序。 */
export const PERMISSION_MODE_CYCLE: readonly PermissionMode[] = [
  "default",
  "auto-edit",
  "plan",
  "auto",
  "full-auto",
];

/** 选择器里标 `Recommended` 的模式。 */
export const RECOMMENDED_PERMISSION_MODE: PermissionMode = "auto";

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_INFO[mode]?.label ?? mode;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_MODES_STRICT_FIRST as readonly string[]).includes(value)
  );
}

/** Shift+Tab 的下一个；当前模式不在循环里（allowlist）时回到第一个。 */
export function nextCycleMode(mode: PermissionMode): PermissionMode {
  const index = PERMISSION_MODE_CYCLE.indexOf(mode);
  return PERMISSION_MODE_CYCLE[(index + 1) % PERMISSION_MODE_CYCLE.length] as PermissionMode;
}

/** line 模式 `/permission` 与 `/permissions` 用的纯文本列表（与选择器同一顺序与标注）。 */
export function permissionModeLines(
  current: PermissionMode,
  configDefault: PermissionMode,
): string[] {
  return PERMISSION_MODE_ORDER.map((mode, i) => {
    const info = PERMISSION_MODE_INFO[mode];
    const tags = [
      ...(mode === configDefault ? ["Default"] : []),
      ...(mode === RECOMMENDED_PERMISSION_MODE ? ["Recommended"] : []),
    ];
    const mark = mode === current ? "✔" : " ";
    const tail = tags.length > 0 ? `  [${tags.join(", ")}]` : "";
    return `${mark} ${i + 1}. ${info.label} (${mode}) — ${info.description}${tail}`;
  });
}

/** 审批对话框与提示里 auto 判定层的名字（随界面语言）。 */
export function autoLayerText(layer: "rule" | "static" | "classifier"): string {
  return msg().permissions.autoLayer[layer];
}

/**
 * 命令参数里的模式：接受值（`auto-edit`）或显示名（`Accept edits`、`accept-edits`，大小写不敏感）。
 */
export function parsePermissionMode(text: string): PermissionMode | undefined {
  const key = text.trim().toLowerCase();
  if (isPermissionMode(key)) return key;
  const squash = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");
  return PERMISSION_MODE_ORDER.find(
    (mode) => squash(PERMISSION_MODE_INFO[mode].label) === squash(key),
  );
}
