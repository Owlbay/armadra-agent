/**
 * 大粘贴折叠（设计 §12.4）：超过 10 行或超过 1 000 字符的粘贴折叠为 `[粘贴 #N · M 行]`，
 * 在编辑器里是不可分割段；提交时展开为原文。[B4]
 *
 * - 换行规范化：`\r\n` / 单独的 `\r` → `\n`（括号粘贴里终端常把换行发成 `\r`）。
 * - 未折叠的粘贴把制表符换成 4 个空格（编辑器按列宽渲染，`\t` 没有确定宽度）；折叠内容保留原文。
 * - 标记只在本编辑器记录过的编号上展开；用户手打的同形文本不会被替换成别的内容。
 */

export const PASTE_LINE_THRESHOLD = 10;
export const PASTE_CHAR_THRESHOLD = 1000;

const MARKER_RE = /\[粘贴 #(\d+) · (\d+) 行\]/g;

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/** 是否需要折叠（> 10 行或 > 1 000 字符）。 */
export function shouldCollapse(text: string): boolean {
  return countLines(text) > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD;
}

export function formatMarker(id: number, lines: number): string {
  return `[粘贴 #${id} · ${lines} 行]`;
}

export class PasteStore {
  private next = 1;
  private readonly entries = new Map<number, string>();

  /** 处理一次粘贴：返回要插入编辑器的文本（折叠标记或规范化后的原文）。 */
  accept(raw: string): string {
    const text = normalizePastedText(raw);
    if (!shouldCollapse(text)) return text.replace(/\t/g, "    ");
    const id = this.next++;
    this.entries.set(id, text);
    return formatMarker(id, countLines(text));
  }

  get size(): number {
    return this.entries.size;
  }

  get(id: number): string | undefined {
    return this.entries.get(id);
  }

  /** 把文本里已登记的标记展开为原文。 */
  expand(text: string): string {
    if (this.entries.size === 0) return text;
    return text.replace(MARKER_RE, (marker, id: string) => this.entries.get(Number(id)) ?? marker);
  }

  /** 一行内已登记标记的区间（编辑器的不可分割段）。 */
  ranges(line: string): Array<readonly [number, number]> {
    if (this.entries.size === 0 || !line.includes("[粘贴 #")) return [];
    const out: Array<readonly [number, number]> = [];
    for (const m of line.matchAll(MARKER_RE)) {
      if (this.entries.has(Number(m[1]))) out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }

  /** 提交后清空（编号继续递增，避免历史里的旧标记与新粘贴混淆）。 */
  clear(): void {
    this.entries.clear();
  }
}
