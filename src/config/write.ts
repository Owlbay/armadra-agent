/**
 * 写配置文件（第三波 §2.3，`ama models discover --write` 用）。[W3-B12]
 *
 * 2 空格缩进 + 换行结尾；目标已存在时先复制为 `<path>.bak`（`backup` 缺省 true）并沿用原文件
 * 权限；先写同目录临时文件再 rename，中途失败不会留下半个 config.json。
 */

import { chmodSync, copyFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AmaConfig } from "./types.js";

export function writeConfigFile(
  path: string,
  config: AmaConfig,
  options: { backup?: boolean } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode: number | undefined;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    mode = undefined;
  }
  if (mode !== undefined && options.backup !== false) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: mode ?? 0o644 });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}
