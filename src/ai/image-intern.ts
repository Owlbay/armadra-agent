/**
 * 图片 base64 按内容哈希驻留（docs/history/memory-plan.md D5、§2.5）。
 *
 * `WeakRef` 的目标不能是字符串，所以驻留单元是 `ImageBlock`：表为 `Map<键, WeakRef<ImageBlock>>`，
 * 键 = `mimeType` + base64 字符串的 sha256；`FinalizationRegistry` 在 block 被回收后清键。命中时返回
 * 已驻留的 block，调用方把它放进内容数组，其中的 base64 字符串随之共享；未命中登记并返回入参。
 * 驻留 block 只在仍被某条消息引用时存活，表本身不增加常驻。block 当作不可变值：没有任何代码就地改它。
 *
 * 哈希一律对 base64 字符串计算（base64 与原始字节一一对应），`read` / 附图与会话恢复的图片才能互相命中。
 */

import { createHash } from "node:crypto";
import type { ImageBlock } from "./types.js";

/**
 * 会话条目的最小形状：ai 不 import session（docs/design/design.md §1.1），`SessionEntry[]` 可直接传入。
 * 只有 `type === "message"` 且 `message.content` 为数组的条目里的 `image` 块参与驻留。
 */
export interface ImageCarrier {
  readonly type: string;
  // 只写 `object`：`{ content?: unknown }` 是弱类型，没有 content 的 `SystemMessage` 赋不进来
  readonly message?: object;
}

/** 内容哈希（小写 hex）；字符串按 UTF-8 计算。 */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const table = new Map<string, WeakRef<ImageBlock>>();
const registry = new FinalizationRegistry<string>((key) => {
  // 同一键可能已换成新 block：只在旧引用确已失效时删
  if (table.get(key)?.deref() === undefined) table.delete(key);
});

/**
 * 返回与 `block` 内容相同的驻留 block；`hash` 是 `block.data`（base64 字符串）的 sha256，缺省时现算。
 */
export function internImage(block: ImageBlock, hash?: string): ImageBlock {
  const key = `${block.mimeType}:${hash ?? sha256Hex(block.data)}`;
  const existing = table.get(key)?.deref();
  if (existing !== undefined && existing.data.length === block.data.length) return existing;
  table.set(key, new WeakRef(block));
  registry.register(block, key);
  return block;
}

/** 就地把会话条目里的图片 block 换成驻留 block，返回替换数（已是驻留对象的不计）。 */
export function internSessionImages(entries: readonly ImageCarrier[]): number {
  let replaced = 0;
  for (const entry of entries) {
    const message = entry.type === "message" ? (entry.message as { content?: unknown }) : undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (let i = 0; i < content.length; i++) {
      const block = content[i] as Partial<ImageBlock> | null;
      if (block?.type !== "image" || typeof block.data !== "string") continue;
      const interned = internImage(block as ImageBlock);
      if (interned !== block) {
        content[i] = interned;
        replaced++;
      }
    }
  }
  return replaced;
}

/** 驻留表当前的键数（测试与诊断用；包括目标已回收、清理回调尚未运行的键）。 */
export function internedImageCount(): number {
  return table.size;
}
