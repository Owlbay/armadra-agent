/**
 * config.json 每个键的说明与缺省值：config.schema.json（编辑器悬停）与 `ama config show`（来源 default
 * 的行）共用这一张表。
 *
 * - `description` 写在消息目录 `src/i18n/messages/config-keys.ts`（中英两份，`keyDoc(path)` 按界面
 *   语言取）；缺省值不手写，从 `DEFAULT_CONFIG`（merge.ts）、`DEFAULT_CACHE_CONFIG`（types.ts）与代码里的隐式缺省（`IMPLICIT_DEFAULTS`）合成 `DISPLAY_DEFAULTS`；
 * - 缺省值取决于运行时的键（自动选模型、跟随预设等）列在消息目录的 `dynamicDefaults`
 *   （`isDynamicDefault(path)`），schema 里不写 `default`，说明里写规则；
 * - 一致性由 json-schema.test.ts 守住：schema 的每个键都在表里，表里的每个键 schema 都有，缺省值与
 *   DISPLAY_DEFAULTS 相同，DISPLAY_DEFAULTS 本身通过 `validateConfig`。
 */

import { DEFAULT_IDLE_TIMEOUT_MS } from "../ai/http.js";
import { DEFAULT_CODEX_CLIENT_VERSION } from "../auth/chatgpt/presets.js";
import { messagesFor, msg } from "../i18n/index.js";
import { DEFAULT_INLINE_BUDGET } from "../codemode/declarations.js";
import { DEFAULT_CONFIG, mergeConfig } from "./merge.js";
import { DEFAULT_CACHE_CONFIG, DEFAULT_CHECKPOINTS_CONFIG, type AmaConfig } from "./types.js";

/** 代码里生效、但 DEFAULT_CONFIG 不写的缺省（写进去会改变合并结果或 `config.codemode` 的有无）。 */
const IMPLICIT_DEFAULTS: Partial<AmaConfig> = {
  providers: {},
  permission: { builtinDeny: true, autoSafeCommands: [] },
  tools: { default: [] },
  codemode: { inlineBudget: DEFAULT_INLINE_BUDGET, requireStrict: false },
  cache: { ...DEFAULT_CACHE_CONFIG },
  request: { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS },
  ui: { compact: false, logo: "auto", animation: true, restoreOnCancel: true, language: "auto" },
  // [W6-C0] 第六波键的缺省（行为由各批次实现）
  memory: {
    enabled: false,
    scopes: ["user", "project"],
    indexMaxBytes: 4096,
    fileMaxBytes: 16384,
    maxFiles: 200,
    subagents: "read",
  },
  auth: {
    chatgpt: {
      flavor: "siwc",
      issuer: "https://auth.openai.com",
      originator: "codex_cli_rs",
      codexClientVersion: DEFAULT_CODEX_CLIENT_VERSION,
    },
  },
  checkpoints: { ...DEFAULT_CHECKPOINTS_CONFIG },
  sandbox: { enabled: "auto", bash: "off", network: "deny", writable: [] },
  // [W5-C0] 第五波键的缺省（行为由各批次实现）
  compaction: { prune: { keepResults: 5, clearAtLeast: "auto" }, pruneExclude: [] },
  images: { resize: "auto" },
  plan: { bash: "readonly", unattended: "stop" },
  agents: { maxConcurrent: 3, dirs: [] },
  subagents: { maxConcurrent: 4, maxPending: 16 },
  reminders: { todo: true, fileChanges: true, contextPressure: true, budget: true },
  todo: { reminder: 10 },
};

/** 全部有固定缺省值的键（展示用；运行时仍以 DEFAULT_CONFIG 合并）。 */
export const DISPLAY_DEFAULTS: Readonly<AmaConfig> = Object.freeze(
  mergeConfig(DEFAULT_CONFIG as AmaConfig, IMPLICIT_DEFAULTS),
);

/** 缺省值由运行时决定的键 → 规则（当前界面语言；schema 不写 default）。 */
export function dynamicDefaults(): Readonly<Record<string, string>> {
  return msg().config.dynamicDefaults;
}

/** 该键的缺省值是否由运行时决定（与语言无关）。 */
export function isDynamicDefault(path: string): boolean {
  return Object.hasOwn(messagesFor("en").config.dynamicDefaults, path);
}

/** 键路径 → 说明（当前界面语言；段落本身也有一条）。 */
export function configKeyDocs(): Readonly<Record<string, string>> {
  return msg().config.keys;
}

/** 一个键的说明（当前界面语言）；没有说明返回 undefined。 */
export function keyDoc(path: string): string | undefined {
  const docs: Readonly<Record<string, string>> = msg().config.keys;
  return Object.hasOwn(docs, path) ? docs[path] : undefined;
}

/**
 * @deprecated 中文原表（第六波前的导出，供尚未迁移的调用方编译通过）；新代码用 `keyDoc(path)` /
 * `configKeyDocs()`。
 */
export const CONFIG_KEY_DOCS: Readonly<Record<string, string>> = messagesFor("zh").config.keys;

/** @deprecated 中文原表；新代码用 `dynamicDefaults()` / `isDynamicDefault(path)`。 */
export const DYNAMIC_DEFAULTS: Readonly<Record<string, string>> =
  messagesFor("zh").config.dynamicDefaults;

/** 叶子路径（段落不算）。 */
export function documentedLeaves(): string[] {
  const keys = Object.keys(messagesFor("en").config.keys);
  return keys.filter((key) => !keys.some((other) => other.startsWith(`${key}.`)));
}

/** 键路径的缺省值（DISPLAY_DEFAULTS 里取；没有返回 undefined）。 */
export function defaultFor(path: string): unknown {
  let node: unknown = DISPLAY_DEFAULTS;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}
