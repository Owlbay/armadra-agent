/**
 * 第六波配置键的校验（docs/wave6-plan.md §7；规则与 json-schema.ts 一一对应，json-schema.test.ts 守住）。[W6-C0]
 *
 * 类型 / 取值错误是 error，未知字段是 warning。只校验形状；行为由各批次实现。
 */

import { isAbsolute } from "node:path";
import { msg } from "../i18n/index.js";
import { checkSection, join, type Checker, type Obj } from "./checker.js";
import {
  AGENT_BAR_MODES,
  CHATGPT_FLAVORS,
  LANGUAGE_SETTINGS,
  MEMORY_SCOPES,
  MEMORY_SUBAGENT_MODES,
} from "./types-w6.js";

/** 第六波新增的顶层键（schema.ts 的 CONFIG_KEYS 并入）。 */
export const W6_CONFIG_KEYS = ["memory", "auth"] as const;

/** 已有 `ui` 段新增的键。 */
export const W6_UI_KEYS = ["language", "replyLanguage", "agentBar"] as const;

export const MEMORY_KEYS = [
  "enabled",
  "scopes",
  "indexMaxBytes",
  "fileMaxBytes",
  "maxFiles",
  "subagents",
] as const;

export const CHATGPT_AUTH_KEYS = [
  "flavor",
  "clientId",
  "issuer",
  "originator",
  "redirectPorts",
] as const;

export function checkUiW6(c: Checker, ui: Obj, path: string): void {
  c.oneOf(ui, "language", path, LANGUAGE_SETTINGS);
  c.string(ui, "replyLanguage", path);
  c.oneOf(ui, "agentBar", path, AGENT_BAR_MODES);
}

function checkEnumArray(
  c: Checker,
  value: Obj,
  key: string,
  path: string,
  choices: readonly string[],
): void {
  const v = value[key];
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string" || !choices.includes(item)))
    c.error(join(path, key), msg().config.schema.enumArray(choices));
}

function checkPorts(c: Checker, value: Obj, key: string, path: string): void {
  const v = value[key];
  if (v === undefined) return;
  if (
    !Array.isArray(v) ||
    v.some(
      (item) => typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 65535,
    )
  )
    c.error(join(path, key), msg().config.schema.ports);
}

/** 第六波顶层段的校验（validateConfig 末尾调用）。 */
export function validateConfigW6(c: Checker, config: Obj): void {
  checkSection(c, config, "memory", MEMORY_KEYS, (s, p) => {
    c.boolean(s, "enabled", p);
    checkEnumArray(c, s, "scopes", p, MEMORY_SCOPES);
    c.number(s, "indexMaxBytes", p, 0, 1_048_576);
    c.number(s, "fileMaxBytes", p, 1, 1_048_576);
    c.number(s, "maxFiles", p, 1, 10_000);
    c.oneOf(s, "subagents", p, MEMORY_SUBAGENT_MODES);
  });
  checkSection(c, config, "auth", ["chatgpt"], (s, p) => {
    const chatgpt = s["chatgpt"];
    const cp = join(p, "chatgpt");
    if (chatgpt === undefined || !c.object(chatgpt, cp)) return;
    c.keys(chatgpt, cp, CHATGPT_AUTH_KEYS);
    c.oneOf(chatgpt, "flavor", cp, CHATGPT_FLAVORS);
    for (const key of ["clientId", "issuer", "originator"]) c.string(chatgpt, key, cp);
    checkPorts(c, chatgpt, "redirectPorts", cp);
  });
}

/** auth.json 的 OAuth 条目（`type: "oauth"`，W6-O）：只查形状，不碰 token 内容。 */
export function checkOAuthEntry(c: Checker, entry: Obj, path: string): void {
  c.keys(entry, path, [
    "type",
    "flavor",
    "clientId",
    "issuer",
    "accountId",
    "planType",
    "email",
    "accessToken",
    "refreshToken",
    "idToken",
    "expiresAt",
    "lastRefresh",
    "acknowledgedAt",
    "needsLogin",
  ]);
  c.oneOf(entry, "flavor", path, CHATGPT_FLAVORS);
  if (entry["flavor"] === undefined) c.error(join(path, "flavor"), msg().config.schema.required);
  c.string(entry, "accessToken", path, true);
  c.string(entry, "refreshToken", path, true);
  for (const key of ["clientId", "issuer", "accountId", "planType", "email", "idToken"])
    c.string(entry, key, path);
  for (const key of ["lastRefresh", "acknowledgedAt"]) c.string(entry, key, path);
  c.number(entry, "expiresAt", path);
  if (entry["expiresAt"] === undefined)
    c.error(join(path, "expiresAt"), msg().config.schema.required);
  c.boolean(entry, "needsLogin", path);
}

/** profile.json 的 `memory`（D11）：`enabled: true` 时 `dir` 必填且为绝对路径。 */
export function checkProfileMemory(c: Checker, profile: Obj): void {
  const memory = profile["memory"];
  if (memory === undefined || !c.object(memory, "memory")) return;
  c.keys(memory, "memory", ["enabled", "dir"]);
  if (typeof memory["enabled"] !== "boolean")
    c.error("memory.enabled", msg().config.schema.required);
  c.string(memory, "dir", "memory");
  const dir = memory["dir"];
  if (memory["enabled"] === true && (typeof dir !== "string" || !isAbsolute(dir)))
    c.error("memory.dir", msg().config.schema.memoryDir);
}
