/**
 * 编辑器补全（设计 §12.4）。[B7]
 *
 * - 首行行首 `/`：内置命令（commands-core 的表 + 交互模式自有命令）、提示模板 `/<名字>`、
 *   Skill `/skill:<名字>`；名字前缀匹配排前，其次子串匹配。
 * - `@` 文件（行首或空白之后）：遍历会话 cwd（尊重 .gitignore，复用 tools/ignore.ts 的 walk），
 *   最多 50 项；查询含 glob 字符时按 glob（tools/glob.ts）匹配相对路径，否则按「文件名前缀 → 路径前缀 →
 *   文件名子串 → 路径子串」排序。目录以 `/` 结尾，可继续补全。文件表按 cwd 缓存 15 秒、最多 20 000 项。
 */

import { msg } from "../../i18n/index.js";
import { GlobMatcher } from "../../tools/glob.js";
import { walk } from "../../tools/ignore.js";
import type {
  AutocompleteContext,
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteResult,
} from "../../tui.js";

export const MAX_FILE_ITEMS = 50;
export const MAX_FILE_INDEX = 20_000;
export const FILE_INDEX_TTL_MS = 15_000;

export interface CompletionCommand {
  name: string;
  args?: string;
  description: string;
}

export interface CompletionSource {
  commands(): readonly CompletionCommand[];
  prompts(): readonly { name: string }[];
  skills(): readonly { name: string; description: string }[];
  cwd(): string;
  now?(): number;
}

interface FileIndex {
  cwd: string;
  at: number;
  entries: { rel: string; isDir: boolean }[];
}

const GLOB_CHARS = /[*?[{]/;

function rank(name: string, query: string): number | undefined {
  const lower = name.toLowerCase();
  const q = query.toLowerCase();
  if (lower.startsWith(q)) return 0;
  if (lower.includes(q)) return 1;
  return undefined;
}

function basename(rel: string): string {
  const trimmed = rel.endsWith("/") ? rel.slice(0, -1) : rel;
  const at = trimmed.lastIndexOf("/");
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

/** 文件匹配排序：0 文件名前缀 / 1 路径前缀 / 2 文件名子串 / 3 路径子串。 */
export function fileScore(rel: string, query: string): number | undefined {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const base = basename(rel).toLowerCase();
  const path = rel.toLowerCase();
  if (base.startsWith(q)) return 0;
  if (path.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (path.includes(q)) return 3;
  return undefined;
}

export class InteractiveCompletion implements AutocompleteProvider {
  private index: FileIndex | undefined;
  private loading: Promise<FileIndex> | undefined;

  constructor(private readonly source: CompletionSource) {}

  getSuggestions(
    context: AutocompleteContext,
  ): AutocompleteResult | null | Promise<AutocompleteResult | null> {
    const before = context.textBeforeCursor;
    const firstLine = context.text.startsWith(context.line);
    const slash = /^\/(\S*)$/.exec(before);
    if (slash !== null && firstLine) return this.slash(slash[1] ?? "");
    const at = /(?:^|\s)@(\S*)$/.exec(before);
    if (at !== null) {
      const query = at[1] ?? "";
      return this.files(query).then((items) =>
        items.length === 0 ? null : { items, from: before.length - query.length - 1 },
      );
    }
    return null;
  }

  private slash(query: string): AutocompleteResult | null {
    const ranked: { item: AutocompleteItem; score: number; order: number }[] = [];
    const push = (value: string, description: string, key: string): void => {
      const score = rank(key, query);
      if (score === undefined) return;
      ranked.push({
        item: { value: `/${value}`, label: `/${value}`, description },
        score,
        order: ranked.length,
      });
    };
    for (const command of this.source.commands()) {
      push(
        command.name,
        command.args !== undefined
          ? `${command.args}  ${command.description}`
          : command.description,
        command.name,
      );
    }
    for (const prompt of this.source.prompts())
      push(prompt.name, msg().interactive.completion.promptTemplate, prompt.name);
    for (const skill of this.source.skills()) {
      push(`skill:${skill.name}`, skill.description, `skill:${skill.name}`);
    }
    if (ranked.length === 0) return null;
    ranked.sort((a, b) => a.score - b.score || a.order - b.order);
    return { items: ranked.slice(0, MAX_FILE_ITEMS).map((r) => r.item), from: 0 };
  }

  private now(): number {
    return this.source.now?.() ?? Date.now();
  }

  /** 文件表（缓存）；并发请求共用一次遍历。 */
  async fileIndex(): Promise<FileIndex> {
    const cwd = this.source.cwd();
    const cached = this.index;
    if (cached !== undefined && cached.cwd === cwd && this.now() - cached.at < FILE_INDEX_TTL_MS) {
      return cached;
    }
    this.loading ??= (async () => {
      const entries: FileIndex["entries"] = [];
      const controller = new AbortController();
      try {
        for await (const entry of walk(cwd, { signal: controller.signal })) {
          entries.push({ rel: entry.isDir ? `${entry.rel}/` : entry.rel, isDir: entry.isDir });
          if (entries.length >= MAX_FILE_INDEX) {
            controller.abort();
            break;
          }
        }
      } catch {
        // 遍历出错（权限等）：用已收集到的部分
      }
      const index: FileIndex = { cwd, at: this.now(), entries };
      this.index = index;
      return index;
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  async files(query: string): Promise<AutocompleteItem[]> {
    const { entries } = await this.fileIndex();
    let matched: { rel: string; score: number }[];
    if (GLOB_CHARS.test(query)) {
      let matcher: GlobMatcher;
      try {
        matcher = new GlobMatcher(query);
      } catch {
        return [];
      }
      matched = entries
        .filter((e) => !e.isDir && matcher.matches(e.rel))
        .map((e) => ({ rel: e.rel, score: 0 }));
    } else {
      matched = [];
      for (const entry of entries) {
        const score = fileScore(entry.rel, query);
        if (score !== undefined) matched.push({ rel: entry.rel, score });
      }
    }
    const depth = (rel: string): number => rel.split("/").filter(Boolean).length;
    matched.sort(
      (a, b) =>
        a.score - b.score ||
        depth(a.rel) - depth(b.rel) ||
        a.rel.length - b.rel.length ||
        a.rel.localeCompare(b.rel),
    );
    return matched.slice(0, MAX_FILE_ITEMS).map((m) => ({ value: `@${m.rel}`, label: m.rel }));
  }
}
