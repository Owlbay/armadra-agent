/**
 * `Ctrl+V` 与 `/paste`：剪贴板图片写进 `<dataDir>/clipboard/`，输入框插入 `@<路径>`（发送时按 `@图片`
 * 附件读取）。[W5-U] 读取本身在 tools/clipboard-image.ts（W5-I）。
 */

import { readClipboardImage, type ClipboardDeps } from "../../tools/clipboard-image.js";

export type PasteOutcome = { ok: true; ref: string; path: string } | { ok: false; message: string };

export const NO_CLIPBOARD_TOOL =
  "读不了剪贴板图片：没有可用的系统命令（macOS osascript / pngpaste，Linux wl-paste / xclip，Windows PowerShell）";
export const NO_CLIPBOARD_IMAGE = "剪贴板里没有图片";

/** `@路径`；路径带空白时加引号。 */
export function imageRef(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

export async function pasteImage(dataDir: string, deps?: ClipboardDeps): Promise<PasteOutcome> {
  try {
    const result = await readClipboardImage(dataDir, deps);
    if (result.ok) return { ok: true, ref: imageRef(result.path), path: result.path };
    return {
      ok: false,
      message: result.reason === "no_tool" ? NO_CLIPBOARD_TOOL : NO_CLIPBOARD_IMAGE,
    };
  } catch (error) {
    return {
      ok: false,
      message: `读取剪贴板失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
