/**
 * 用户在编辑器里改记忆（`/memory edit`、`ama memory edit`）。[W6-M]
 *
 * - 目标是已有条目：编辑全文副本，存回时与模型写入同一套规范化、凭据检查与上限（store.saveRaw）；
 * - 目标是作用域名（或省略 = 第一个作用域）：编辑新条目模板，按 `name` 生成文件名（重名加 `-2`、`-3`…）；
 * - 编辑器非零退出 → cancelled；内容没变 / 新条目没写名字 → unchanged。
 * 编辑器在临时文件上工作（modes/interactive/external-editor.ts），作用域目录里不会留下半截文件。
 */

import { parseEntry } from "./frontmatter.js";
import { MEMORY_SCOPE_ORDER, type MemoryScope } from "./paths.js";
import { findOne } from "./report.js";
import type { MemoryStore } from "./store.js";

export type EditOutcome =
  | { status: "saved"; path: string }
  | { status: "unchanged" }
  | { status: "cancelled" }
  | { status: "not_found"; message: string };

/** 编辑器：给全文与临时文件名，返回改后的全文；没保存返回 undefined。 */
export type EditText = (text: string, fileName: string) => Promise<string | undefined>;

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug === "" ? "note" : slug;
}

function template(scope: MemoryScope): string {
  const type = scope === "user" ? "user" : "project";
  return `---\nname: \ndescription: \ntype: ${type}\n---\n\n`;
}

function freeFile(store: MemoryStore, scope: MemoryScope, base: string): string {
  const taken = new Set(store.entries(scope).map((e) => e.file));
  if (!taken.has(`${base}.md`)) return `${base}.md`;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}.md`)) return `${base}-${n}.md`;
}

export async function editMemory(
  store: MemoryStore,
  target: string | undefined,
  edit: EditText,
): Promise<EditOutcome> {
  const scopes = store.scopes();
  const asScope = MEMORY_SCOPE_ORDER.find((s) => s === target && scopes.includes(s));
  if (target === undefined || asScope !== undefined) {
    const scope = asScope ?? scopes[0];
    if (scope === undefined) return { status: "unchanged" };
    const before = template(scope);
    const after = await edit(before, "memory.md");
    if (after === undefined) return { status: "cancelled" };
    const name = (parseEntry(after).meta["name"] ?? "").trim();
    if (after === before || name === "") return { status: "unchanged" };
    const file = freeFile(store, scope, slugify(name));
    return { status: "saved", path: (await store.saveRaw(scope, file, after)).path };
  }
  const found = findOne(store, target);
  if (!found.ok) return { status: "not_found", message: found.message };
  const before = store.readRaw(found.entry) ?? "";
  const after = await edit(before, found.entry.file.split("/").at(-1) ?? "memory.md");
  if (after === undefined) return { status: "cancelled" };
  if (after === before) return { status: "unchanged" };
  return {
    status: "saved",
    path: (await store.saveRaw(found.entry.scope, found.entry.file, after)).path,
  };
}
