/**
 * 写入前的凭据检查（docs/history/wave6-plan.md D10、§3.3）。[W6-M]
 *
 * 判定以 `session/redact.ts` 的 `redactSecrets` 为准（脱敏后与原文不同 = 命中）；命中即拒写，不写遮蔽版。
 * 命中类型只用于告诉模型 / 用户「像什么」，按形态粗分。
 */

import { redactSecrets } from "../session/redact.js";

const KINDS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "API key"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, "GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bnpm_[A-Za-z0-9]{30,}/, "npm token"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "JWT"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/, "authorization header"],
];

/** 像凭据时返回类型（英文短语），否则 undefined。 */
export function credentialKind(text: string): string | undefined {
  if (redactSecrets(text) === text) return undefined;
  for (const [pattern, kind] of KINDS) if (pattern.test(text)) return kind;
  return "secret assignment";
}
