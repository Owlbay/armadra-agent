/**
 * 外部 Agent 子进程环境清理（docs/wave5-plan.md §5.4，D16）。[W5-E]
 *
 * ama 分不清「用户 shell 本来就有」与「为 ama 设的」变量，所以缺省全剥、显式放回：
 * - 删：`BUILTIN_PROVIDERS[].envKeys`（各家 API key）、`*_BASE_URL`、`AMA_*`、`CODEX_API_KEY`、
 *   `ANTHROPIC_AUTH_TOKEN`——它们漏进 Claude / Codex 会把订阅登录切成 API 计费（R2 K4）；
 * - 留：其余全部（PATH / HOME / LANG / TERM / SSH_* / 代理变量 / CLI 自己的 OAuth 令牌等）；
 * - 放回：`agents.<id>.env.passthrough` 列出的变量（从原环境取值）。
 *
 * Windows 上变量名不分大小写，比较一律转大写。`--bare` 之类改用 API key 的旗标永不缺省（驱动侧）。
 */

import { BUILTIN_PROVIDERS } from "../ai/providers/builtin.js";
import { agentEntry, type AgentsConfig } from "../config/types-w5.js";

/** 除供应商表之外也要剥离的变量（会让 CLI 改用 API 计费）。 */
export const EXTRA_STRIPPED_KEYS: readonly string[] = ["CODEX_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

let providerKeys: ReadonlySet<string> | undefined;

function strippedKeys(): ReadonlySet<string> {
  providerKeys ??= new Set(
    [...BUILTIN_PROVIDERS.flatMap((p) => p.envKeys ?? []), ...EXTRA_STRIPPED_KEYS].map((k) =>
      k.toUpperCase(),
    ),
  );
  return providerKeys;
}

/** 该变量是否缺省剥离。 */
export function isStrippedEnvKey(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith("AMA_") || upper.endsWith("_BASE_URL") || strippedKeys().has(upper);
}

export function buildChildEnv(
  env: NodeJS.ProcessEnv,
  agentId: string,
  config: AgentsConfig | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isStrippedEnvKey(name)) continue;
    out[name] = value;
  }
  const passthrough = agentEntry(config, agentId)?.env?.passthrough ?? [];
  if (passthrough.length > 0) {
    const wanted = new Set(passthrough.map((n) => n.toUpperCase()));
    for (const [name, value] of Object.entries(env))
      if (value !== undefined && wanted.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}
