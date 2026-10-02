/**
 * 消息目录：config（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I4]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 */

import type { Messages } from "../types.js";

export const en = {
  /** 配置校验诊断（[W6-C0] 第六波新键用；既有诊断由 W6-I4 迁入）。 */
  schema: {
    enumArray: (choices: readonly string[]) => `should be an array of ${choices.join(" | ")}`,
    ports: "should be an array of port numbers (0–65535; 0 = any free port)",
    required: "required",
    memoryDir: "memory.enabled is true but memory.dir is not an absolute path",
  },
  /** 层级合并（merge.ts）的告警。 */
  merge: {
    projectIgnored: (label: string, key: string) =>
      `${label}: ${key} cannot be set at project level; ignored`,
    projectMemoryOnlyDisable: (label: string) =>
      `${label}: project level can only set memory.enabled to false; other memory keys ignored`,
  },
};

export const zh = {
  schema: {
    enumArray: (choices) => `应为 ${choices.join(" | ")} 组成的数组`,
    ports: "应为端口号数组（0–65535；0 = 任意空闲端口）",
    required: "缺少必填字段",
    memoryDir: "memory.enabled 为 true 时 memory.dir 必须是绝对路径",
  },
  merge: {
    projectIgnored: (label, key) => `${label}: 项目级不能设 ${key}，已忽略`,
    projectMemoryOnlyDisable: (label) =>
      `${label}: 项目级只能把 memory.enabled 设为 false，忽略 memory 的其它键`,
  },
} satisfies Messages<typeof en>;
