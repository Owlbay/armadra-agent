/**
 * 第五波配置键的校验（docs/wave5-plan.md §9；schema.ts 已近 600 行，新键放这里）。[W5-C0]
 *
 * 规则与 json-schema.ts 一一对应（json-schema.test.ts 的正反例守住）：类型 / 取值错误是 error，
 * 未知字段是 warning。只校验形状；行为由各批次实现。
 */

import { PERMISSION_MODES_STRICT_FIRST } from "../permissions/types.js";
import { msg } from "../i18n/index.js";
import { Checker, THINKING_LEVELS, checkSection, join, type Obj } from "./checker.js";
import {
  AGENTS_RESERVED_KEYS,
  IMAGE_RESIZE_MODES,
  MODELS_ENABLED_REF,
  PLAN_BASH_MODES_STRICT_FIRST,
  PLAN_UNATTENDED_MODES,
  STATUS_LINE_MODES,
  SUBAGENT_BACKGROUND_MODES,
} from "./types-w5.js";

/** 第五波新增的顶层键（schema.ts 的 CONFIG_KEYS 并入）。 */
export const W5_CONFIG_KEYS = [
  "images",
  "plan",
  "agents",
  "subagents",
  "models",
  "fallbackModel",
  "limits",
  "reminders",
  "todo",
] as const;

/** 已有段新增的键。 */
export const W5_UI_KEYS = ["statusLine"] as const;
export const W5_COMPACTION_KEYS = ["prune", "pruneExclude"] as const;

/** `agents.<id>` 的 id：子 Agent 名（`^[a-z0-9-]`）或外部 Agent（可带 `acp:` 前缀）。 */
export const AGENT_ID_PATTERN = /^(acp:)?[a-z0-9][a-z0-9._-]{0,63}$/;

const AGENT_ENTRY_KEYS = ["maxConcurrent", "maxMode", "model", "env"] as const;

export function checkUiW5(c: Checker, ui: Obj, path: string): void {
  c.oneOf(ui, "statusLine", path, STATUS_LINE_MODES);
}

export function checkCompactionW5(c: Checker, compaction: Obj, path: string): void {
  c.stringArray(compaction, "pruneExclude", path);
  const prune = compaction["prune"];
  const p = join(path, "prune");
  if (prune === undefined || !c.object(prune, p)) return;
  c.keys(prune, p, ["keepResults", "clearAtLeast"]);
  c.number(prune, "keepResults", p, 0);
  const clear = prune["clearAtLeast"];
  if (clear !== undefined && clear !== "auto" && (typeof clear !== "number" || clear < 0))
    c.error(join(p, "clearAtLeast"), msg().config.schema.clearAtLeast);
}

function checkAgentEntry(c: Checker, entry: unknown, path: string): void {
  if (!c.object(entry, path)) return;
  c.keys(entry, path, AGENT_ENTRY_KEYS);
  c.number(entry, "maxConcurrent", path, 1, 64);
  c.oneOf(entry, "maxMode", path, PERMISSION_MODES_STRICT_FIRST);
  c.string(entry, "model", path);
  const env = entry["env"];
  const envPath = join(path, "env");
  if (env !== undefined && c.object(env, envPath)) {
    c.keys(env, envPath, ["passthrough"]);
    c.stringArray(env, "passthrough", envPath);
  }
}

function checkAgents(c: Checker, config: Obj): void {
  const agents = config["agents"];
  if (agents === undefined || !c.object(agents, "agents")) return;
  c.number(agents, "maxConcurrent", "agents", 1, 64);
  c.number(agents, "sessionBudgetUsd", "agents", 0);
  c.stringArray(agents, "dirs", "agents");
  for (const [id, entry] of Object.entries(agents)) {
    if ((AGENTS_RESERVED_KEYS as readonly string[]).includes(id)) continue;
    const p = join("agents", id);
    if (!AGENT_ID_PATTERN.test(id)) c.error(p, msg().config.schema.agentId);
    else checkAgentEntry(c, entry, p);
  }
}

/** 第五波顶层段的校验（validateConfig 末尾调用）。 */
export function validateConfigW5(c: Checker, config: Obj): void {
  checkSection(c, config, "images", ["resize"], (s, p) =>
    c.oneOf(s, "resize", p, IMAGE_RESIZE_MODES),
  );
  checkSection(
    c,
    config,
    "plan",
    ["bash", "directory", "unattended", "model", "thinkingLevel"],
    (s, p) => {
      c.oneOf(s, "bash", p, PLAN_BASH_MODES_STRICT_FIRST);
      c.string(s, "directory", p);
      c.oneOf(s, "unattended", p, PLAN_UNATTENDED_MODES);
      c.string(s, "model", p);
      c.oneOf(s, "thinkingLevel", p, THINKING_LEVELS);
    },
  );
  checkAgents(c, config);
  checkSection(
    c,
    config,
    "subagents",
    ["maxConcurrent", "maxPending", "defaultModel", "background", "autoBackgroundAfterMs"],
    (s, p) => {
      c.number(s, "maxConcurrent", p, 1, 64);
      c.number(s, "maxPending", p, 0, 1024);
      c.string(s, "defaultModel", p);
      c.oneOf(s, "background", p, SUBAGENT_BACKGROUND_MODES);
      c.number(s, "autoBackgroundAfterMs", p, 0);
    },
  );
  checkSection(c, config, "models", ["aliases", "enabled"], (s, p) => {
    c.stringArray(s, "enabled", p);
    const enabled = s["enabled"];
    if (Array.isArray(enabled))
      enabled.forEach((ref, i) => {
        if (typeof ref === "string" && !MODELS_ENABLED_REF.test(ref))
          c.error(join(join(p, "enabled"), i), msg().config.schema.modelsEnabled);
      });
    const aliases = s["aliases"];
    const ap = join(p, "aliases");
    if (aliases === undefined || !c.object(aliases, ap)) return;
    c.keys(aliases, ap, ["fast", "strong"]);
    c.string(aliases, "fast", ap);
    c.string(aliases, "strong", ap);
  });
  c.string(config, "fallbackModel", "");
  checkSection(c, config, "limits", ["maxTurns", "maxCostUsd"], (s, p) => {
    c.number(s, "maxTurns", p, 1);
    c.number(s, "maxCostUsd", p, 0);
  });
  checkSection(
    c,
    config,
    "reminders",
    ["todo", "fileChanges", "contextPressure", "budget"],
    (s, p) => {
      for (const key of ["todo", "fileChanges", "contextPressure", "budget"]) c.boolean(s, key, p);
    },
  );
  checkSection(c, config, "todo", ["reminder"], (s, p) => c.number(s, "reminder", p, 0));
}
