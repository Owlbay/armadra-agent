/**
 * 请求体序列化（docs/memory-plan.md D3、§2.3）。[M-C0] 签名就位；[M-B] 实现分块序列化：
 * 含 ≥ {@link LARGE_STRING_BYTES} 的无需转义字符串（图片 base64）时按结构逐键拼 Buffer 片段，
 * 大字符串不经中间 JSON 字符串；其余一律交给原生 `JSON.stringify`。
 */

/** 达到这个长度（UTF-16 码元）的字符串才走片段路径。 */
export const LARGE_STRING_BYTES = 64 * 1024;

/** 与 `Buffer.from(JSON.stringify(body), "utf8")` 逐字节相同；大字符串不经中间字符串。 */
export function serializeJsonBody(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), "utf8");
}
