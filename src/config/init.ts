/**
 * 配置目录初始化（docs/providers.md「配置目录」）：`ama init` 与 CLI 首次运行的自动初始化。
 *
 * - 目录 0700；`config.json` 只在不存在时写最小内容（`--force` 时先备份再重写）：只有 `$schema`、
 *   `version` 与空 `providers`，不写死任何缺省值——缺省值以后调整（例如 codemode 跟随预设）对老用户
 *   同样生效，`config show` 的来源也显示 default 而不是 user；
 * - `config.schema.json` 不是用户文件，每次 init 都按当前版本与当前界面语言重写（内容相同则不动；
 *   说明跟随界面语言，D21）；
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
import { msg } from "../i18n/index.js";
import { CONFIG_SCHEMA_FILE, configSchemaText } from "./json-schema.js";
import { AUTH_FILE, CONFIG_FILE } from "./paths.js";
import { CONFIG_FILE_VERSION, type AmaConfig } from "./types.js";

export const NO_INIT_ENV = "AMA_NO_INIT";

/** 最小 config.json：只有 `$schema`、`version` 与空 `providers`（缺省值见 `ama config show`）。 */
export function minimalConfig(): AmaConfig & { $schema: string } {
  return {
    $schema: `./${CONFIG_SCHEMA_FILE}`,
    version: CONFIG_FILE_VERSION,
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

/** init 之后的下一步（配 key / 接中转站 / 自检；当前界面语言）。 */
export function initNextSteps(): string[] {
  return msg().config.init.nextSteps.split("\n");
}

export function describeInit(result: InitResult): string {
  const m = msg().config.init;
  const lines = [`${result.dir}  ${result.dirCreated ? m.dirCreated : m.dirExists}`];
  for (const file of result.files) lines.push(`  ${file.path}  ${m.status[file.status]}`);
  return `${lines.join("\n")}\n`;
}
