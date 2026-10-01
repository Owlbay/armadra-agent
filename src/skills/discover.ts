/**
 * Skill 发现（设计 §5.3、§7.3）。[B3]
 *
 * 顺序：`--skill-dir`（可重复）→ profile `skillDirs` → config `skills.dirs` → `<configDir>/skills/`
 * → `<cwd>/.ama/skills/`（需信任）→ 祖先目录的 `.agents/skills/`（需信任；从 cwd 向上到仓库根，
 * 近者在前）。每个含 `SKILL.md` 的子目录是一个技能（递归查找，技能目录内部不再下钻）；重名保留
 * 先发现者并 warning。信任结果由调用方（B5 的 trust 决策）作为参数传入；未信任时需信任的来源被
 * 跳过并记入 `skippedUntrusted`。
 *
 * frontmatter：`name`（≤ 64，`^[a-z0-9-]+$`，缺省取目录名）、`description`（必填，≤ 1024）、
 * `disable-model-invocation`、`allowed-tools`（只做提示）。
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export type SkillScope = "cli" | "profile" | "config" | "user" | "project" | "ancestor";

export interface SkillSource {
  dir: string;
  scope: SkillScope;
  requiresTrust: boolean;
}

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md 绝对路径。 */
  location: string;
  /** SKILL.md 所在目录。 */
  baseDir: string;
  disableModelInvocation: boolean;
  allowedTools?: string[];
  scope: SkillScope;
}

export interface DiscoverResult {
  skills: Skill[];
  warnings: string[];
  /** 因未信任而跳过的目录（存在的才列出）。 */
  skippedUntrusted: string[];
}

export const SKILL_FILE = "SKILL.md";
export const SKILL_NAME_RE = /^[a-z0-9-]+$/;
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface SkillSourceOptions {
  cwd: string;
  /** 用户级配置目录（`~/.config/ama`）。 */
  configDir: string;
  cliDirs?: readonly string[];
  profileDirs?: readonly string[];
  configDirs?: readonly string[];
}

/** 从 cwd 向上到仓库根（含 `.git` 的目录，含其本身）；无仓库则到文件系统根。近者在前。 */
export function ancestorDirs(cwd: string): string[] {
  const out: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    out.push(dir);
    if (existsSync(join(dir, ".git"))) return out;
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

export function skillSources(options: SkillSourceOptions): SkillSource[] {
  const sources: SkillSource[] = [];
  const add = (dir: string, scope: SkillScope, requiresTrust: boolean) =>
    sources.push({ dir: resolve(options.cwd, dir), scope, requiresTrust });
  for (const d of options.cliDirs ?? []) add(d, "cli", false);
  for (const d of options.profileDirs ?? []) add(d, "profile", false);
  for (const d of options.configDirs ?? []) add(d, "config", false);
  add(join(options.configDir, "skills"), "user", false);
  add(join(options.cwd, ".ama", "skills"), "project", true);
  for (const d of ancestorDirs(options.cwd)) add(join(d, ".agents", "skills"), "ancestor", true);
  return sources;
}

/** 解析一份 SKILL.md；不合格返回 warning。 */
export function parseSkill(
  text: string,
  location: string,
  scope: SkillScope,
): { skill?: Skill; warnings: string[] } {
  const warnings: string[] = [];
  const fm = parseFrontmatter(text);
  for (const e of fm.errors) warnings.push(`${location}: ${e}`);
  const baseDir = dirname(location);
  const rawName = fm.data["name"];
  const name = typeof rawName === "string" && rawName !== "" ? rawName : basename(baseDir);
  if (name.length > MAX_SKILL_NAME || !SKILL_NAME_RE.test(name)) {
    warnings.push(`${location}: invalid skill name "${name}" (lowercase letters, digits, -)`);
    return { warnings };
  }
  const description = fm.data["description"];
  if (typeof description !== "string" || description.trim() === "") {
    warnings.push(`${location}: missing description; skill "${name}" not loaded`);
    return { warnings };
  }
  if (description.length > MAX_SKILL_DESCRIPTION) {
    warnings.push(`${location}: description longer than ${MAX_SKILL_DESCRIPTION} characters`);
    return { warnings };
  }
  const skill: Skill = {
    name,
    description: description.trim(),
    location,
    baseDir,
    disableModelInvocation: fm.data["disable-model-invocation"] === true,
    scope,
  };
  const allowed = fm.data["allowed-tools"];
  if (Array.isArray(allowed)) skill.allowedTools = allowed.map(String);
  else if (typeof allowed === "string" && allowed !== "") {
    skill.allowedTools = allowed.split(/[\s,]+/).filter((t) => t !== "");
  }
  return { skill, warnings };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 一个来源目录下全部 SKILL.md（排序、递归；含 SKILL.md 的目录本身是技能，不再下钻）。 */
export async function findSkillFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const own = join(dir, SKILL_FILE);
  if (existsSync(own)) return [own];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  names.sort();
  const out: string[] = [];
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const child = join(dir, name);
    if (await isDir(child)) out.push(...(await findSkillFiles(child, depth + 1)));
  }
  return out;
}

export async function discoverSkills(
  sources: readonly SkillSource[],
  options: { trusted: boolean },
): Promise<DiscoverResult> {
  const result: DiscoverResult = { skills: [], warnings: [], skippedUntrusted: [] };
  const byName = new Map<string, Skill>();
  const seenDirs = new Set<string>();
  for (const source of sources) {
    if (seenDirs.has(source.dir)) continue;
    seenDirs.add(source.dir);
    if (!(await isDir(source.dir))) continue;
    if (source.requiresTrust && !options.trusted) {
      result.skippedUntrusted.push(source.dir);
      continue;
    }
    for (const file of await findSkillFiles(source.dir)) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        result.warnings.push(`${file}: ${(err as Error).message}`);
        continue;
      }
      const parsed = parseSkill(text, file, source.scope);
      result.warnings.push(...parsed.warnings);
      if (!parsed.skill) continue;
      const existing = byName.get(parsed.skill.name);
      if (existing) {
        result.warnings.push(
          `${file}: skill "${parsed.skill.name}" already defined at ${existing.location}; ignored`,
        );
        continue;
      }
      byName.set(parsed.skill.name, parsed.skill);
      result.skills.push(parsed.skill);
    }
  }
  return result;
}
