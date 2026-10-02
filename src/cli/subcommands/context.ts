/**
 * 子命令共用：读用户级配置（+ 可选 profile）并构造供应商注册表。[B5]
 */

import { resolve } from "node:path";
import type { ProviderRegistryApi } from "../../ai/types.js";
import { defaultAuthFilePath } from "../../config/auth-file.js";
import { loadConfigFile } from "../../config/load.js";
import { mergeBaseLayers, type MergeResult } from "../../config/merge.js";
import { CONFIG_FILE, resolveConfigDir, resolveDataDir, userFile } from "../../config/paths.js";
import { loadProfile, type ProfileOptions } from "../../config/profile.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { hideFakeProvider } from "../fake-visibility.js";

export interface UserLevel {
  configDir: string;
  dataDir: string;
  profile?: ProfileOptions;
  merged: MergeResult;
  userConfigPath: string;
  authFile: string;
  warnings: string[];
}

export function loadUserLevel(
  io: CliIo,
  options: { profile?: string | undefined; authFile?: string | undefined } = {},
): UserLevel {
  const configDir = resolveConfigDir({ env: io.env });
  const dataDir = resolveDataDir({ env: io.env });
  const warnings: string[] = [];
  const profile = options.profile === undefined ? undefined : loadProfile(options.profile, io.cwd);
  if (profile !== undefined) warnings.push(...profile.warnings);
  const userConfigPath = userFile({ configDir }, CONFIG_FILE);
  const user = loadConfigFile("config", userConfigPath);
  if (user !== undefined) warnings.push(...user.warnings);
  const merged = mergeBaseLayers({
    user: user?.value,
    profile: profile?.config,
    hasProfile: profile !== undefined,
  });
  const authFile =
    options.authFile !== undefined
      ? resolve(io.cwd, options.authFile)
      : (profile?.authFile ?? defaultAuthFilePath(configDir));
  const result: UserLevel = { configDir, dataDir, merged, userConfigPath, authFile, warnings };
  if (profile !== undefined) result.profile = profile;
  return result;
}

export async function buildRegistry(
  level: UserLevel,
  io: CliIo,
  deps: Pick<RuntimeDeps, "providers">,
): Promise<ProviderRegistryApi> {
  // 列表类子命令（doctor / models list / providers list / config show）缺省不列 fake
  const registry = await deps.providers.create({
    config: level.merged.config,
    cwd: io.cwd,
    authFile: level.authFile,
    authEnv: level.profile?.authEnv ?? true,
    dataDir: level.dataDir,
  });
  return hideFakeProvider(registry, io.env);
}
