/**
 * profile.json（宿主用，设计 §10.3、§11.1 第 3 步、§11.2）。[B5]
 *
 * profile 的字段等价于对应命令行参数；命令行显式参数优先（合并在 cli/bootstrap.ts）。
 * 文件不存在 / 版本不符 / 路径不是绝对路径 → StartupError（退出码 3）。profile 不含密钥。
 */

import { isAbsolute, resolve } from "node:path";
import { StartupError } from "../errors.js";
import { loadConfigFile } from "./load.js";
import { PROFILE_PATH_FIELDS, PROFILE_PATH_LIST_FIELDS } from "./schema.js";
import type { AmaConfig, ProfileFile } from "./types.js";

const EXIT_CONFIG = 3;

/** profile 展开后的等价参数（全部为绝对路径）。 */
export interface ProfileOptions {
  path: string;
  host?: string;
  instructions: string[];
  skillDirs: string[];
  promptDirs: string[];
  /** [W5-C0] 子 Agent 定义目录（W5-G 接入发现）。 */
  agentDirs?: string[];
  hooksFile?: string;
  authFile?: string;
  /** false：key 只来自 authFile。 */
  authEnv: boolean;
  sessionDir?: string;
  /** profile.config 文件路径。 */
  configFile?: string;
  /** profile.config 的内容（已校验）。 */
  config?: AmaConfig;
  trustProject: boolean;
  warnings: string[];
}

export function loadProfile(path: string, cwd = process.cwd()): ProfileOptions {
  const abs = resolve(cwd, path);
  const loaded = loadConfigFile("profile", abs, { required: true });
  if (loaded === undefined) {
    throw new StartupError("profile_invalid", `${abs}: 文件不存在`, EXIT_CONFIG);
  }
  const profile = loaded.value;
  const relative: string[] = [];
  for (const key of PROFILE_PATH_FIELDS) {
    const value = profile[key];
    if (value !== undefined && !isAbsolute(value)) relative.push(`${key}: ${value}`);
  }
  for (const key of PROFILE_PATH_LIST_FIELDS) {
    for (const value of profile[key] ?? []) {
      if (!isAbsolute(value)) relative.push(`${key}: ${value}`);
    }
  }
  if (relative.length > 0) {
    throw new StartupError(
      "profile_invalid",
      `${abs}: profile 中的路径必须是绝对路径：\n  ${relative.join("\n  ")}`,
      EXIT_CONFIG,
    );
  }
  const options = profileToOptions(abs, profile, loaded.warnings);
  if (profile.config !== undefined) {
    const config = loadConfigFile("config", profile.config, { required: true });
    if (config !== undefined) {
      options.config = config.value;
      options.warnings.push(...config.warnings);
    }
  }
  return options;
}

function profileToOptions(path: string, profile: ProfileFile, warnings: string[]): ProfileOptions {
  const options: ProfileOptions = {
    path,
    instructions: [...(profile.instructions ?? [])],
    skillDirs: [...(profile.skillDirs ?? [])],
    promptDirs: [...(profile.promptDirs ?? [])],
    authEnv: profile.authEnv !== false,
    trustProject: profile.trustProject === true,
    warnings: [...warnings],
  };
  if (profile.agentDirs !== undefined) options.agentDirs = [...profile.agentDirs];
  if (profile.host !== undefined) options.host = profile.host;
  if (profile.hooksFile !== undefined) options.hooksFile = profile.hooksFile;
  if (profile.authFile !== undefined) options.authFile = profile.authFile;
  if (profile.sessionDir !== undefined) options.sessionDir = profile.sessionDir;
  if (profile.config !== undefined) options.configFile = profile.config;
  return options;
}
