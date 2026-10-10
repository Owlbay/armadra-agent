/**
 * 界面语言（docs/history/wave6-plan.md §5.1、§5.2、D18；docs/guides/i18n.md）。[W6-C0]
 *
 * - 语言优先级：`AMA_LANG` > `--lang` > `ui.language`（`auto` 视为未设）> `LC_ALL` / `LC_MESSAGES` /
 *   `LANG` 第一个非空值；`/^zh/i` → zh，其余（含 `C` / `POSIX` / 空 / 判断不出）→ en。
 * - 进程启动时定一次（`cli/main.ts` 解析参数与配置后、任何渲染前 `setLocale()`；SDK `createRuntime({ language })`
 *   与 profile `language` 同理），不做运行中切换。未调用 `setLocale` 时首次取用按环境变量推断。
 * - 取用：`const m = msg().print; io.stderr(m.limitTurns(limit))`——嵌套属性访问，不用字符串键；
 *   **不要在模块顶层求值**（顶层 `const x = msg()…` 会按 import 时的语言定死，`scripts/check-i18n.mjs` 会拦）。
 * - **给模型的文本固定英文、不走这里**：模型侧模块禁止 import `src/i18n`（`src/i18n/guard.test.ts`）。
 */

import { CATALOGS, type Catalog } from "./catalog.js";

export type { Catalog } from "./catalog.js";
export { MESSAGE_DOMAINS } from "./catalog.js";
export type { Messages, MessageLeaf } from "./types.js";
export { formatDuration, plural } from "./format.js";

export type Locale = "zh" | "en";
export const LOCALES: readonly Locale[] = ["zh", "en"];

/** `ui.language` 的取值。 */
export type LanguageSetting = "auto" | Locale;
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["auto", "zh", "en"];

/** 语言从哪里来（`ama doctor` 显示「界面语言：zh（来源 LANG=zh_CN.UTF-8）」）。 */
export type LocaleSource =
  | { kind: "env"; name: "AMA_LANG"; value: string }
  | { kind: "cli" }
  | { kind: "config" }
  | { kind: "locale"; name: "LC_ALL" | "LC_MESSAGES" | "LANG"; value: string }
  | { kind: "default" };

/** 把 `zh` / `zh_CN.UTF-8` / `en-US` 之类的写法归一；不是 zh / en 的返回 undefined。 */
export function parseLocale(value: string | undefined): Locale | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (/^zh/i.test(v)) return "zh";
  if (/^en/i.test(v)) return "en";
  return undefined;
}

const LOCALE_VARS = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

/** 解析语言并给出来源。 */
export function resolveLocaleWithSource(
  env: NodeJS.ProcessEnv,
  config?: { language?: LanguageSetting | undefined },
  cli?: Locale,
): { locale: Locale; source: LocaleSource } {
  const ama = env["AMA_LANG"];
  const fromEnv = parseLocale(ama);
  if (fromEnv !== undefined && ama !== undefined)
    return { locale: fromEnv, source: { kind: "env", name: "AMA_LANG", value: ama } };
  if (cli !== undefined) return { locale: cli, source: { kind: "cli" } };
  const configured = config?.language;
  if (configured === "zh" || configured === "en")
    return { locale: configured, source: { kind: "config" } };
  for (const name of LOCALE_VARS) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    // 第一个非空值说了算：zh* → zh，其余（en_US、C、POSIX…）→ en
    return {
      locale: parseLocale(value) === "zh" ? "zh" : "en",
      source: { kind: "locale", name, value },
    };
  }
  return { locale: "en", source: { kind: "default" } };
}

/** 解析语言（见文件头的优先级）。 */
export function resolveLocale(
  env: NodeJS.ProcessEnv,
  config?: { language?: LanguageSetting | undefined },
  cli?: Locale,
): Locale {
  return resolveLocaleWithSource(env, config, cli).locale;
}

let current: Locale | undefined;

/** 定下本进程的界面语言（启动时调用一次；测试 setup 钉 zh）。 */
export function setLocale(locale: Locale): void {
  current = locale;
}

/** 当前界面语言；未 `setLocale` 时按环境变量推断（不缓存，便于 SDK 嵌入方之后再定）。 */
export function getLocale(): Locale {
  return current ?? resolveLocale(process.env);
}

/** 当前语言的消息目录。 */
export function msg(): Catalog {
  return CATALOGS[getLocale()];
}

/** 指定语言的消息目录（导出产物按导出时语言渲染等场景）。 */
export function messagesFor(locale: Locale): Catalog {
  return CATALOGS[locale];
}
