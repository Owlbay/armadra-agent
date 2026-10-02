/**
 * 配置目录初始化（docs/providers.md「配置目录」）：`ama init` 与 CLI 首次运行的自动初始化。
 *
 * - 目录 0700；`config.json` 只在不存在时写最小内容（`--force` 时先备份再重写）；
 * - `config.schema.json` 不是用户文件，每次 init 都按当前版本重写（内容相同则不动）；
 * - 不创建 auth.json（只有 `ama auth set` / `ama providers add` 才写，0600）。
 * - 自动初始化只在 CLI 里、配置目录不存在时触发，`AMA_NO_INIT=1` 关闭；SDK 与测试不走这里。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CONFIG_SCHEMA_FILE, configSchemaText } from "./json-schema.js";
import { AUTH_FILE, CONFIG_FILE } from "./paths.js";
import { CONFIG_FILE_VERSION, type AmaConfig } from "./types.js";

export const NO_INIT_ENV = "AMA_NO_INIT";

/** 最小 config.json：常用键的缺省值（与 DEFAULT_CONFIG 相同，写出来方便直接改）。 */
export function minimalConfig(): AmaConfig & { $schema: string } {
  return {
    $schema: `./${CONFIG_SCHEMA_FILE}`,
    version: CONFIG_FILE_VERSION,
    thinkingLevel: "medium",
    permission: { mode: "default" },
    tools: { preset: "default" },
    providers: {},
  };
}

export type InitStatus = "created" | "exists" | "updated" | "unchanged" | "overwritten";

export interface InitResult {
  dir: string;
  dirCreated: boolean;
  files: { path: string; status: InitStatus }[];
}

function writeAtomic(path: string, text: string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

/** 建目录并补齐缺失文件；已有的 config.json 不覆盖（`force` 时备份为 .bak 再重写）。 */
export function initConfigDir(dir: string, options: { force?: boolean } = {}): InitResult {
  const dirCreated = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (dirCreated && process.platform !== "win32") chmodSync(dir, 0o700);
  const files: InitResult["files"] = [];
  const config = join(dir, CONFIG_FILE);
  const text = `${JSON.stringify(minimalConfig(), null, 2)}\n`;
  if (!existsSync(config)) {
    writeAtomic(config, text, 0o644);
    files.push({ path: config, status: "created" });
  } else if (options.force) {
    copyFileSync(config, `${config}.bak`);
    writeAtomic(config, text, 0o644);
    files.push({ path: config, status: "overwritten" });
  } else files.push({ path: config, status: "exists" });
  const schema = join(dir, CONFIG_SCHEMA_FILE);
  const schemaText = configSchemaText();
  if (!existsSync(schema)) {
    writeAtomic(schema, schemaText, 0o644);
    files.push({ path: schema, status: "created" });
  } else if (readFileSync(schema, "utf8") !== schemaText) {
    writeAtomic(schema, schemaText, 0o644);
    files.push({ path: schema, status: "updated" });
  } else files.push({ path: schema, status: "unchanged" });
  const auth = join(dir, AUTH_FILE);
  if (existsSync(auth)) files.push({ path: auth, status: "exists" });
  return { dir, dirCreated, files };
}

/** CLI 启动时：配置目录不存在就静默初始化；返回是否初始化了。失败不影响启动。 */
export function autoInitConfigDir(
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (env[NO_INIT_ENV] === "1" || existsSync(dir)) return false;
  try {
    initConfigDir(dir);
    return true;
  } catch {
    return false;
  }
}

const STATUS_TEXT: Record<InitStatus, string> = {
  created: "已创建",
  exists: "已存在，未改动",
  updated: "已更新为当前版本",
  unchanged: "已是当前版本",
  overwritten: "已重写（原文件备份为 .bak）",
};

export function describeInit(result: InitResult): string {
  const lines = [`${result.dir}${result.dirCreated ? "  已创建（0700）" : "  已存在"}`];
  for (const file of result.files) lines.push(`  ${file.path}  ${STATUS_TEXT[file.status]}`);
  return `${lines.join("\n")}\n`;
}
