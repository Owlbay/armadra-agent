/**
 * 检查点配置解析（docs/history/rewind-plan.md §5）。[RW-A]
 *
 * `AMA_CHECKPOINTS`（tools | shadow-git | off）> config `checkpoints.mode` > 缺省 tools；
 * 无效的环境变量值 warn 后忽略。`maxFileBytes` / `keep` 取配置，缺省 5 MiB / 100。
 */

import { CHECKPOINT_MODES, DEFAULT_CHECKPOINTS_CONFIG, type AmaConfig } from "../config/types.js";
import type { CheckpointMode } from "./types.js";
import { msg } from "../i18n/index.js";

export interface CheckpointSettings {
  mode: CheckpointMode;
  maxFileBytes: number;
  keep: number;
}

export function resolveCheckpointSettings(
  config: Pick<AmaConfig, "checkpoints"> | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: (message: string) => void = () => {},
): CheckpointSettings {
  const section = config?.checkpoints ?? {};
  let mode: CheckpointMode = section.mode ?? DEFAULT_CHECKPOINTS_CONFIG.mode;
  const raw = env["AMA_CHECKPOINTS"]?.trim();
  if (raw !== undefined && raw !== "") {
    if ((CHECKPOINT_MODES as readonly string[]).includes(raw)) mode = raw as CheckpointMode;
    else warn(msg().session.checkpoints.invalidEnv(raw, CHECKPOINT_MODES));
  }
  return {
    mode,
    maxFileBytes: section.maxFileBytes ?? DEFAULT_CHECKPOINTS_CONFIG.maxFileBytes,
    keep: section.keep ?? DEFAULT_CHECKPOINTS_CONFIG.keep,
  };
}
