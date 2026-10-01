/**
 * 项目信任（设计 §6.1「信任边界」、§7.3）。[B5]
 *
 * - 需要信任：`.ama/hooks.json`、`.ama/skills/`、`.ama/prompts/`、祖先 `.agents/skills/`。
 *   不需要：AGENTS.md、`.ama/config.json`（它只能收紧）。
 * - 决策顺序：`--trust` / `--no-trust` → profile `trustProject: true` → trust.json 中最近祖先的
 *   记录 → 交互模式询问（一次，可记住）→ 非交互缺省不信任。
 * - trust.json 只在用户级目录；写入为原子替换。
 */

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { TrustState } from "../cli/runtime.js";
import { loadConfigFile } from "./load.js";
import { PROJECT_DIR, TRUST_FILE } from "./paths.js";
import type { TrustEntry, TrustFile } from "./types.js";
import { CONFIG_FILE_VERSION } from "./types.js";

export type { TrustState } from "../cli/runtime.js";

export function trustFilePath(configDir: string): string {
  return join(configDir, TRUST_FILE);
}

/** 读 trust.json；不存在 → 空表。语法 / 字段错误抛 StartupError（3）。 */
export function readTrustFile(configDir: string): TrustFile {
  const loaded = loadConfigFile("trust", trustFilePath(configDir));
  return loaded?.value ?? { version: CONFIG_FILE_VERSION, entries: [] };
}

function normalize(path: string, platform: NodeJS.Platform): string {
  const abs = resolve(path);
  const trimmed = abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs;
  return platform === "win32" || platform === "darwin" ? trimmed.toLowerCase() : trimmed;
}

/** `dir` 是否等于 `ancestor` 或在其下。 */
export function isWithin(dir: string, ancestor: string, platform = process.platform): boolean {
  const d = normalize(dir, platform);
  const a = normalize(ancestor, platform);
  if (d === a) return true;
  const prefix = a.endsWith(sep) ? a : a + sep;
  return d.startsWith(prefix);
}

/** 最近祖先（路径最长）的记录。 */
export function findTrustEntry(
  entries: readonly TrustEntry[],
  cwd: string,
  platform = process.platform,
): TrustEntry | undefined {
  let best: TrustEntry | undefined;
  for (const entry of entries) {
    if (!isWithin(cwd, entry.path, platform)) continue;
    if (
      best === undefined ||
      normalize(entry.path, platform).length >= normalize(best.path, platform).length
    ) {
      best = entry;
    }
  }
  return best;
}

/** 记录信任决策（同路径覆盖）。 */
export function recordTrust(
  configDir: string,
  path: string,
  trusted: boolean,
  now = new Date(),
): void {
  const file = readTrustFile(configDir);
  const abs = resolve(path);
  const entries = file.entries.filter(
    (e) => normalize(e.path, process.platform) !== normalize(abs, process.platform),
  );
  entries.push({ path: abs, trusted, at: now.toISOString() });
  const target = trustFilePath(configDir);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: CONFIG_FILE_VERSION, entries }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, target);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** cwd 下需要信任才能加载的资源（为空则无需询问）。 */
export function trustGatedResources(cwd: string): string[] {
  const found: string[] = [];
  const project = join(cwd, PROJECT_DIR);
  if (existsSync(join(project, "hooks.json"))) found.push(join(project, "hooks.json"));
  for (const sub of ["skills", "prompts"]) {
    if (isDir(join(project, sub))) found.push(join(project, sub));
  }
  for (const dir of ancestorsOf(cwd)) {
    const skills = join(dir, ".agents", "skills");
    if (isDir(skills)) found.push(skills);
  }
  return found;
}

/** cwd 自身与全部祖先（由内向外）。 */
export function ancestorsOf(cwd: string): string[] {
  const result: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

export interface TrustPromptAnswer {
  trusted: boolean;
  /** 写入 trust.json。 */
  remember: boolean;
}

export interface DecideTrustInput {
  cwd: string;
  configDir: string;
  /** `--trust` → true、`--no-trust` → false。 */
  flag?: boolean | undefined;
  /** profile.trustProject。 */
  profileTrust?: boolean | undefined;
  interactive: boolean;
  /** 交互询问；不提供或非交互时跳过。 */
  prompt?: ((cwd: string, resources: readonly string[]) => Promise<TrustPromptAnswer>) | undefined;
}

export async function decideTrust(input: DecideTrustInput): Promise<TrustState> {
  if (input.flag !== undefined) return { trusted: input.flag, source: "flag" };
  if (input.profileTrust === true) return { trusted: true, source: "profile" };
  const entry = findTrustEntry(readTrustFile(input.configDir).entries, input.cwd);
  if (entry !== undefined) {
    return { trusted: entry.trusted, source: "trust-file", matchedPath: entry.path };
  }
  if (input.interactive && input.prompt !== undefined) {
    const resources = trustGatedResources(input.cwd);
    // 没有需要信任的资源就不打扰用户；不信任对结果没有影响。
    if (resources.length === 0) return { trusted: false, source: "default" };
    const answer = await input.prompt(input.cwd, resources);
    if (answer.remember) recordTrust(input.configDir, input.cwd, answer.trusted);
    return { trusted: answer.trusted, source: "prompt" };
  }
  return { trusted: false, source: "default" };
}
