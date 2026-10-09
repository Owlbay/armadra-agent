/**
 * 图片 base64 按内容哈希驻留（docs/memory-plan.md D5、§2.5）。[M-C0] 签名就位、行为为直通；
 * [M-D] 实现 `Map<sha256hex, WeakRef<ImageBlock>>` + `FinalizationRegistry` 清键：同一内容的图片
 * 共享同一个 block（与其中的字符串），只在仍被某条消息引用时存活。
 */

import { createHash } from "node:crypto";
import type { ImageBlock } from "./types.js";

/**
 * 会话条目的最小形状：ai 不 import session（docs/design.md §1.1），`SessionEntry[]` 可直接传入。
 * 只有 `type === "message"` 且 `message.content` 为数组的条目里的 `image` 块参与驻留。
 */
export interface ImageCarrier {
  readonly type: string;
  readonly message?: { readonly content?: unknown };
}

/** 内容哈希（小写 hex）；字符串按 UTF-8 计算。 */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 返回与 `block` 内容相同的驻留 block；`hash` 缺省时对 `block.data` 计算。[M-C0] 原样返回。 */
export function internImage(block: ImageBlock, hash?: string): ImageBlock {
  void hash;
  return block;
}

/** 就地把会话条目里的图片 block 换成驻留 block，返回替换数。[M-C0] 不替换，返回 0。 */
export function internSessionImages(entries: readonly ImageCarrier[]): number {
  void entries;
  return 0;
}
