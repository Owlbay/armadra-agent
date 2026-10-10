/**
 * codemode 缺省关闭的一次性提示（设计 §5.5「默认开放」）：`default` 预设跟随预设时只在沙箱 strict
 * （Node ≥ 25，或有可用的操作系统沙箱，docs/guides/sandbox.md）开 codemode；否则缺省关闭，启动时提示一次
 * 怎么显式开启。
 *
 * - 只在「跟随预设」且预设是 `default`、运行时不是 strict 时提示；显式写了 `codemode.mode`（含 off）
 *   不提示；
 * - 每个配置目录只提示一次：已提示过的配置目录记在 `<数据目录>/notices.json`；读写失败不影响启动
 *   （至多多提示一次）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxCapability } from "../codemode/capability.js";
import type { AmaConfig } from "../config/types.js";
import { resolveCodemodeMode } from "../tools/presets.js";
import { msg } from "../i18n/index.js";

export const NOTICES_FILE = "notices.json";
const KEY = "codemodeNonStrictDefault";

interface NoticesFile {
  version: 1;
  [KEY]?: string[];
}

function readNotices(path: string): NoticesFile {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const shown = (value as Record<string, unknown>)[KEY];
      return {
        version: 1,
        ...(Array.isArray(shown) ? { [KEY]: shown.filter((s) => typeof s === "string") } : {}),
      };
    }
  } catch {
    // 不存在或损坏：按没提示过处理
  }
  return { version: 1 };
}

export function codemodeNoticeText(capability: Pick<SandboxCapability, "nodeMajor">): string {
  return msg().cli.codemodeNotice(capability.nodeMajor);
}

/** 需要提示时返回文案并记下（之后同一配置目录不再提示）；不需要时 undefined。 */
export function takeCodemodeNotice(input: {
  config: Pick<AmaConfig, "tools" | "codemode" | "sandbox">;
  capability: Pick<SandboxCapability, "strict" | "nodeMajor">;
  configDir: string;
  dataDir: string;
}): string | undefined {
  const resolved = resolveCodemodeMode(input.config, input.capability.strict);
  if (resolved.source !== "preset" || resolved.preset !== "default" || input.capability.strict)
    return undefined;
  const path = join(input.dataDir, NOTICES_FILE);
  const notices = readNotices(path);
  const shown = notices[KEY] ?? [];
  if (shown.includes(input.configDir)) return undefined;
  try {
    mkdirSync(input.dataDir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...notices, [KEY]: [...shown, input.configDir] })}\n`);
    renameSync(tmp, path);
  } catch {
    // 写不进去也照常提示
  }
  return codemodeNoticeText(input.capability);
}
