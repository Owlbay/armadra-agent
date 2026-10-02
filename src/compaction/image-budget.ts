/**
 * 单请求图片总量预算（docs/wave5-plan.md §4、D11）。[W5-I] 纯函数，无模型调用。
 *
 * base64 图片在历史里每轮重发，几张截图就可能撞上 Anthropic 32 MB / Gemini 20 MB 的请求上限。
 * `planImageBudget` 给出要降级的消息：调用方把每条写成 `context_edit{reason:"image_budget"}`，
 * 之后前缀稳定（不是请求时临时处理），未命中归因把它当重置点。
 *
 * 规则（按投影顺序，最旧在前）：
 * 1. 单张超过 `perImageBytes`（换了更小上限的模型 / 中转）的消息必降——发出去必被拒；
 * 2. 总量（含本回合新提示里的图 `reserve`）> 预算时，从最旧的开始降，直到 ≤ 预算 × 60%
 *    （一次多降一些，减少反复失效）；
 * 3. 图片数 > 20 且还有边长 > 2000 px 的图时，继续从最旧的开始降，直到不超过 20 张或没有大图；
 * 规则 2、3 不降最新一条带图的消息（刚读的图要让模型看到）。降级以消息为单位：文本块原样保留，
 * 每个图片块换成占位文本。
 */

import type { ContentBlock, ImageBlock } from "../ai/types.js";
import { MANY_IMAGES_COUNT, MANY_IMAGES_EDGE } from "../ai/image-limits.js";
import type { ContextItem } from "../session/projection.js";
import { imageSize, type ImageSize } from "../tools/image-file.js";

export const IMAGE_BUDGET_TARGET_RATIO = 0.6;
export const IMAGE_OMITTED_FOR_BUDGET = "[earlier image omitted to fit request size]";
export const IMAGE_OMITTED_TOO_LARGE =
  "[image omitted: larger than this endpoint's per-image limit]";

export interface ImageBudgetOptions {
  /** 单张上限（base64 后）；超过的必降。缺省不检查。 */
  perImageBytes?: number;
  /** 本回合即将发送、不能降级的图片（新提示里的附件）：计入总量与张数。 */
  reserve?: readonly ImageBlock[];
  /** 降到预算的这个比例以下；缺省 0.6。 */
  targetRatio?: number;
  /** 测试注入：图片尺寸。缺省解 base64 读文件头。 */
  sizeOf?(block: ImageBlock): ImageSize | undefined;
}

export interface ImageBudgetEdit {
  targetId: string;
  replacement: string;
  /** `per_image`：单张超限；`budget`：总量；`many_images`：> 20 张时的边长。 */
  cause: "per_image" | "budget" | "many_images";
  /** 本条消息里被省略的图片数与 base64 字节。 */
  images: number;
  bytes: number;
}

interface Candidate {
  targetId: string;
  content: readonly ContentBlock[];
  images: ImageBlock[];
  bytes: number;
}

function imagesOf(content: readonly ContentBlock[]): ImageBlock[] {
  return content.filter((block): block is ImageBlock => block.type === "image");
}

function candidates(items: readonly ContextItem[]): Candidate[] {
  const out: Candidate[] = [];
  for (const { entry, message } of items) {
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom")
      continue;
    if (typeof message.content === "string") continue;
    const images = imagesOf(message.content);
    if (images.length === 0) continue;
    const bytes = images.reduce((sum, image) => sum + image.data.length, 0);
    out.push({ targetId: entry.id, content: message.content, images, bytes });
  }
  return out;
}

/** 降级后的文本：文本块原样，图片块换成 `placeholder`，块间换行。 */
export function budgetReplacement(
  content: readonly ContentBlock[],
  placeholder = IMAGE_OMITTED_FOR_BUDGET,
): string {
  return content
    .map((block) => (block.type === "text" ? block.text : placeholder))
    .filter((text) => text !== "")
    .join("\n");
}

const HEAD_CHARS = 512 * 1024;
const sizeCache = new WeakMap<ImageBlock, ImageSize | null>();

/** 解 base64 读文件头取尺寸（先解前 384 KB；JPEG 的 SOF 更靠后时再解全量）；按块缓存。 */
export function base64ImageSize(block: ImageBlock): ImageSize | undefined {
  const cached = sizeCache.get(block);
  if (cached !== undefined) return cached ?? undefined;
  let size = imageSize(Buffer.from(block.data.slice(0, HEAD_CHARS), "base64"), block.mimeType);
  if (size === undefined && block.data.length > HEAD_CHARS)
    size = imageSize(Buffer.from(block.data, "base64"), block.mimeType);
  sizeCache.set(block, size ?? null);
  return size;
}

export function planImageBudget(
  items: readonly ContextItem[],
  budgetBytes: number,
  options: ImageBudgetOptions = {},
): ImageBudgetEdit[] {
  const all = candidates(items);
  const plan: ImageBudgetEdit[] = [];
  const drop = (c: Candidate, cause: ImageBudgetEdit["cause"]): void => {
    const placeholder = cause === "per_image" ? IMAGE_OMITTED_TOO_LARGE : IMAGE_OMITTED_FOR_BUDGET;
    plan.push({
      targetId: c.targetId,
      replacement: budgetReplacement(c.content, placeholder),
      cause,
      images: c.images.length,
      bytes: c.bytes,
    });
  };

  // 1. 单张超限
  const perImage = options.perImageBytes;
  const kept: Candidate[] = [];
  for (const c of all) {
    if (perImage !== undefined && c.images.some((image) => image.data.length > perImage))
      drop(c, "per_image");
    else kept.push(c);
  }

  const reserve = options.reserve ?? [];
  let total =
    kept.reduce((sum, c) => sum + c.bytes, 0) +
    reserve.reduce((sum, image) => sum + image.data.length, 0);
  let count = kept.reduce((sum, c) => sum + c.images.length, 0) + reserve.length;
  // 最新一条带图的消息不降
  const droppable = kept.slice(0, -1);
  let next = 0;

  // 2. 总量
  if (total > budgetBytes) {
    const target = budgetBytes * (options.targetRatio ?? IMAGE_BUDGET_TARGET_RATIO);
    while (total > target && next < droppable.length) {
      const c = droppable[next++] as Candidate;
      drop(c, "budget");
      total -= c.bytes;
      count -= c.images.length;
    }
  }

  // 3. > 20 张时的边长
  if (count > MANY_IMAGES_COUNT) {
    const sizeOf = options.sizeOf ?? base64ImageSize;
    const tooWide = (image: ImageBlock): boolean => {
      const size = sizeOf(image);
      return size !== undefined && Math.max(size.width, size.height) > MANY_IMAGES_EDGE;
    };
    const remaining = (): boolean =>
      reserve.some(tooWide) || kept.slice(next).some((c) => c.images.some(tooWide));
    while (count > MANY_IMAGES_COUNT && next < droppable.length && remaining()) {
      const c = droppable[next++] as Candidate;
      drop(c, "many_images");
      count -= c.images.length;
    }
  }
  return plan;
}
