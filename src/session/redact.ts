/**
 * 导出前的机密脱敏（`ama sessions export`）。[W4-D]
 *
 * 只认「形态」：常见 key / token 前缀（sk-…、sk-ant-…、ghp_…、github_pat_…、xox?-…、AIza…、
 * AKIA…、npm_…）、JWT、`Bearer` / `Basic` 凭据、PEM 私钥块，以及 `apiKey` / `secret` / `token` /
 * `password` / `authorization` 之后紧跟 `:` 或 `=` 的值。命中的部分换成 `[REDACTED]`
 * （键名与 Bearer 之类的前缀保留，便于读者知道那里原来有什么）。宁可多遮，不做熵判断。
 */

export const REDACTED = "[REDACTED]";

const TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const SCHEME = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{12,}/g;
const ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|apikey|secret|token|password|passwd|authorization))(["']?\s*[:=]\s*["']?)([^\s"',;}{)]{8,})/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(SCHEME, (_m, scheme: string, space: string) => `${scheme}${space}${REDACTED}`);
  out = out.replace(ASSIGNMENT, (match, key: string, sep: string, value: string) =>
    value === REDACTED || value.startsWith(REDACTED) ? match : `${key}${sep}${REDACTED}`,
  );
  return out;
}

const SECRET_KEY = /(?:api[_-]?key|apikey|secret|token|password|passwd|authorization)$/i;

/**
 * 深拷贝并对全部字符串值脱敏；键名像机密（如 `apiKey`、`authToken`）的字符串值整段遮掉；
 * 图片块的 base64 `data` 原样保留（不会是机密，替换会弄坏图片）。
 */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const image = record["type"] === "image";
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (image && key === "data") out[key] = item;
      else if (typeof item === "string" && item.length >= 8 && SECRET_KEY.test(key))
        out[key] = REDACTED;
      else out[key] = redactValue(item);
    }
    return out as T;
  }
  return value;
}
