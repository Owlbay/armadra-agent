/**
 * 六种权限模式的显示名、一行说明、界面顺序与 Shift+Tab 循环（§7.4）。
 *
 * 显示名用英文（与常见编码 Agent 的叫法一致），说明用界面语言（中文）。界面顺序就是选择器里
 * 数字快捷键 1–6 的顺序；`allowlist` 不在 Shift+Tab 循环里，只能显式选。
 */

import { PERMISSION_MODES_STRICT_FIRST, type PermissionMode } from "./types.js";

export interface PermissionModeInfo {
  label: string;
  description: string;
}

export const PERMISSION_MODE_INFO: Readonly<Record<PermissionMode, PermissionModeInfo>> = {
  default: { label: "Manual", description: "写文件、执行命令前询问" },
  "auto-edit": { label: "Accept edits", description: "自动接受文件编辑，执行命令仍询问" },
  plan: { label: "Plan", description: "只读调研，只跑只读命令，出计划后审批执行" },
  auto: { label: "Auto", description: "由 ama 判断每一步：安全的自动放行，有风险的才问" },
  "full-auto": { label: "Bypass permissions", description: "全部放行（危险命令仍询问）" },
  allowlist: {
    label: "Allowlist only",
    description: "只放行 allow 规则命中的，其余拒绝，从不询问",
  },
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

/** 审批对话框与提示里 auto 判定层的中文名。 */
export const AUTO_LAYER_TEXT: Readonly<Record<"rule" | "static" | "classifier", string>> = {
  rule: "规则层",
  static: "静态判定",
  classifier: "分类器",
};

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
