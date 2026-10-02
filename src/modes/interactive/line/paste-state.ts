/**
 * 括号粘贴状态机（`ESC[200~ … ESC[201~`，设计 §11.2 / §12.3）：按字符流喂入，跨 chunk 识别起止标记，
 * 产出普通输入与完整粘贴两类片段。与 tui/stdin-buffer.ts 独立实现（行式界面不依赖 TUI 组件库）。[B6]
 *
 * - 标记可能被拆在两个 chunk 之间：末尾若是标记的前缀，先留着等下一块；
 * - 粘贴里的 `\r\n` / `\r` 统一成 `\n`；
 * - `flush()`：输入暂停时把留着的前缀当普通输入交出（例如单独按下的 ESC）。
 */

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export type InputPiece = { kind: "text"; text: string } | { kind: "paste"; text: string };

/** `text` 末尾与 `marker` 开头重合的最长长度（不含完整标记）。 */
function partialSuffix(text: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

export class PasteState {
  private inPaste = false;
  private pending = "";
  private pasted = "";

  get pasting(): boolean {
    return this.inPaste;
  }

  feed(chunk: string): InputPiece[] {
    const out: InputPiece[] = [];
    let data = this.pending + chunk;
    this.pending = "";
    while (data.length > 0) {
      if (!this.inPaste) {
        const at = data.indexOf(PASTE_START);
        if (at >= 0) {
          if (at > 0) out.push({ kind: "text", text: data.slice(0, at) });
          this.inPaste = true;
          this.pasted = "";
          data = data.slice(at + PASTE_START.length);
          continue;
        }
        const keep = partialSuffix(data, PASTE_START);
        const text = data.slice(0, data.length - keep);
        if (text !== "") out.push({ kind: "text", text });
        this.pending = data.slice(data.length - keep);
        break;
      }
      const end = data.indexOf(PASTE_END);
      if (end >= 0) {
        this.pasted += data.slice(0, end);
        out.push({ kind: "paste", text: this.pasted.replace(/\r\n?/g, "\n") });
        this.inPaste = false;
        this.pasted = "";
        data = data.slice(end + PASTE_END.length);
        continue;
      }
      const keep = partialSuffix(data, PASTE_END);
      this.pasted += data.slice(0, data.length - keep);
      this.pending = data.slice(data.length - keep);
      break;
    }
    return out;
  }

  /** 交出留着的标记前缀（粘贴中途则不动：等结束标记）。 */
  flush(): InputPiece[] {
    if (this.inPaste || this.pending === "") return [];
    const text = this.pending;
    this.pending = "";
    return [{ kind: "text", text }];
  }
}
