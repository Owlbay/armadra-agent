/**
 * 会话条目树（设计 §8）：按 id 索引、根 → 叶子路径、公共祖先、树形视图。[B2]
 *
 * 条目以 parentId 串成树；多根是允许的（`setLeaf(null)` 后再追加）。所有函数都是纯函数，
 * 输入是文件顺序的条目数组。
 */

import type { SessionEntry, SessionTreeNode } from "./types.js";

export type EntryIndex = ReadonlyMap<string, SessionEntry>;

export function indexEntries(entries: readonly SessionEntry[]): Map<string, SessionEntry> {
  const map = new Map<string, SessionEntry>();
  for (const entry of entries) map.set(entry.id, entry);
  return map;
}

/** 根 → leafId 的路径（含 leaf）；leafId 为 null 或找不到时返回空数组。遇环即停。 */
export function pathToRoot(index: EntryIndex, leafId: string | null): SessionEntry[] {
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current = leafId === null ? undefined : index.get(leafId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : index.get(current.parentId);
  }
  return path.reverse();
}

/** 两个叶子的最深公共祖先 id（无公共祖先 → null）。 */
export function commonAncestor(
  index: EntryIndex,
  a: string | null,
  b: string | null,
): string | null {
  const ancestorsOfA = new Set(pathToRoot(index, a).map((entry) => entry.id));
  const pathB = pathToRoot(index, b);
  for (let i = pathB.length - 1; i >= 0; i--) {
    const entry = pathB[i];
    if (entry !== undefined && ancestorsOfA.has(entry.id)) return entry.id;
  }
  return null;
}

/** 从 `fromId`（不含）往上直到 `ancestorId`（不含）的条目，从旧到新。 */
export function entriesBetween(
  index: EntryIndex,
  ancestorId: string | null,
  fromId: string | null,
): SessionEntry[] {
  const path = pathToRoot(index, fromId);
  if (ancestorId === null) return path;
  const at = path.findIndex((entry) => entry.id === ancestorId);
  return at < 0 ? path : path.slice(at + 1);
}

/** label 条目：同一目标最新一条赢；label 缺省 = 清除。 */
export function collectLabels(entries: readonly SessionEntry[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    if (entry.label === undefined || entry.label === "") labels.delete(entry.targetId);
    else labels.set(entry.targetId, entry.label);
  }
  return labels;
}

/** 文件顺序建树；孤儿（parentId 指向不存在的条目）当作根。 */
export function buildTree(entries: readonly SessionEntry[]): SessionTreeNode[] {
  const labels = collectLabels(entries);
  const nodes = new Map<string, SessionTreeNode>();
  for (const entry of entries) {
    const node: SessionTreeNode = { entry, children: [] };
    const label = labels.get(entry.id);
    if (label !== undefined) node.label = label;
    nodes.set(entry.id, node);
  }
  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.id);
    if (node === undefined) continue;
    const parent = entry.parentId === null ? undefined : nodes.get(entry.parentId);
    if (parent === undefined || parent === node) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

/** 叶子条目（没有子条目的）id，文件顺序。 */
export function leafIds(entries: readonly SessionEntry[]): string[] {
  const hasChild = new Set<string>();
  for (const entry of entries) if (entry.parentId !== null) hasChild.add(entry.parentId);
  return entries.filter((entry) => !hasChild.has(entry.id)).map((entry) => entry.id);
}
