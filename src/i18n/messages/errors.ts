/**
 * 消息目录：errors（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I3]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 */

import type { ImageFileErrorDetail, ImageFitHint } from "../../tools/image-file.js";
import type { Messages } from "../types.js";

const EN_HINT: Record<ImageFitHint, string> = {
  resize_off: " (images.resize is off)",
  no_tool: " (no resize tool found: install ImageMagick, or sips on macOS)",
  still_too_large: " (resizing did not bring it under the limit)",
};

const ZH_HINT: Record<ImageFitHint, string> = {
  resize_off: "（images.resize 为 off）",
  no_tool: "（没找到缩放工具：装 ImageMagick，macOS 自带 sips）",
  still_too_large: "（缩放后仍超限）",
};

export const en = {
  /** [W6-C0] 读图失败（`tools/image-file.ts` 的 `AmaError.detail`），`--image` 与 `@路径` 显示。 */
  imageFile: (d: ImageFileErrorDetail): string => {
    switch (d.reason) {
      case "missing":
        return `Image not found: ${d.path}`;
      case "not_file":
        return `Not a file: ${d.path}`;
      case "unsupported":
        return `Unsupported image (PNG / JPEG / GIF / WebP): ${d.path}`;
      case "too_large":
        return `Image exceeds the ${d.limitMb} limit (counted after base64): ${d.path} (${d.sizeMb})${d.hint === undefined ? "" : EN_HINT[d.hint]}`;
      case "too_wide":
        return `Image edge exceeds ${d.maxEdge} px: ${d.path}${d.size === undefined ? "" : ` (${d.size.width}×${d.size.height})`}${d.hint === undefined ? "" : EN_HINT[d.hint]}`;
    }
  },
};

export const zh = {
  imageFile: (d) => {
    switch (d.reason) {
      case "missing":
        return `图片不存在：${d.path}`;
      case "not_file":
        return `不是文件：${d.path}`;
      case "unsupported":
        return `不是支持的图片（PNG / JPEG / GIF / WebP）：${d.path}`;
      case "too_large":
        return `图片超过 ${d.limitMb} 上限（按 base64 后计算）：${d.path}（${d.sizeMb}）${d.hint === undefined ? "" : ZH_HINT[d.hint]}`;
      case "too_wide":
        return `图片任一边超过 ${d.maxEdge} px：${d.path}${d.size === undefined ? "" : `（${d.size.width}×${d.size.height}）`}${d.hint === undefined ? "" : ZH_HINT[d.hint]}`;
    }
  },
} satisfies Messages<typeof en>;
