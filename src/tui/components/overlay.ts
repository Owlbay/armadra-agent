/**
 * 覆盖层合成（设计 §12.1、§12.2 第 2 步）：只支持 `center` 与 `bottom` 两种锚点。[B4]
 *
 * 覆盖层画在「终端视口」内（内容的最后 height 行）；内容不足覆盖层高度时在末尾补空行。
 * 合成发生在差分之前，所以覆盖层的出现 / 消失与普通内容变化一样只重写变化行。
 */

import type { Component } from "../component.js";
import { SGR_RESET, padToWidth, sliceByColumn, truncateToWidth } from "../ansi.js";

export type OverlayAnchor = "center" | "bottom";

export interface OverlayOptions {
  /** 缺省 `center`。 */
  anchor?: OverlayAnchor;
  /** 覆盖层列宽；缺省 center 为 min(width - 4, 80)，bottom 为整宽。 */
  width?: number;
  /** 最大行数；缺省为终端高度。 */
  maxHeight?: number;
}

export interface OverlayLayer {
  readonly component: Component;
  readonly options: OverlayOptions;
}

function overlayWidth(options: OverlayOptions, width: number): number {
  const anchor = options.anchor ?? "center";
  const wanted = options.width ?? (anchor === "bottom" ? width : Math.min(width - 4, 80));
  return Math.max(1, Math.min(width, wanted));
}

/** 把一行 base 的 [col, col + w) 列替换为 overlay 行。 */
export function spliceLine(
  base: string,
  overlay: string,
  col: number,
  w: number,
  width: number,
): string {
  const left = padToWidth(sliceByColumn(base, 0, col), col);
  const mid = padToWidth(truncateToWidth(overlay, w), w);
  const right = sliceByColumn(base, col + w, width);
  const midReset = mid.includes("\x1b") ? SGR_RESET : "";
  return left + mid + midReset + right;
}

/** 按顺序合成全部覆盖层（后加入的在上）。 */
export function compositeOverlays(
  lines: readonly string[],
  layers: readonly OverlayLayer[],
  width: number,
  height: number,
): string[] {
  let result = [...lines];
  for (const layer of layers) result = compositeOne(result, layer, width, height);
  return result;
}

function compositeOne(
  lines: string[],
  layer: OverlayLayer,
  width: number,
  height: number,
): string[] {
  const ow = overlayWidth(layer.options, width);
  const maxHeight = Math.max(1, Math.min(height, layer.options.maxHeight ?? height));
  let body = layer.component.render(ow);
  if (body.length > maxHeight) body = body.slice(body.length - maxHeight);
  const oh = body.length;
  if (oh === 0) return lines;
  const result = [...lines];
  while (result.length < oh) result.push("");
  const viewportTop = Math.max(0, result.length - height);
  const visible = result.length - viewportTop;
  const anchor = layer.options.anchor ?? "center";
  const startRow =
    anchor === "bottom"
      ? result.length - oh
      : viewportTop + Math.max(0, Math.floor((visible - oh) / 2));
  const col = anchor === "bottom" && ow === width ? 0 : Math.floor((width - ow) / 2);
  for (let i = 0; i < oh; i++) {
    const row = startRow + i;
    result[row] = spliceLine(result[row] ?? "", body[i] ?? "", col, ow, width);
  }
  return result;
}
