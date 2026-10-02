/**
 * `Ctrl+V` 与 `/paste`：剪贴板图片写进 `<dataDir>/clipboard/`，输入框插入 `@<路径>`（发送时按 `@图片`
 * 附件读取）。[W5-U] 读取本身在 tools/clipboard-image.ts（W5-I）。
 */

import { msg } from "../../i18n/index.js";
import { readClipboardImage, type ClipboardDeps } from "../../tools/clipboard-image.js";

export type PasteOutcome = { ok: true; ref: string; path: string } | { ok: false; message: string };

export function noClipboardTool(): string {
  return msg().interactive.clipboard.noTool;
}

export function noClipboardImage(): string {
  return msg().interactive.clipboard.noImage;
}

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
      message: result.reason === "no_tool" ? noClipboardTool() : noClipboardImage(),
    };
  } catch (error) {
    return {
      ok: false,
      message: msg().interactive.clipboard.failed(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}
