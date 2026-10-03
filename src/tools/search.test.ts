/**
 * glob / ignore / grep 对照 fixture 树。树在临时目录里现建（仓库里放 .gitignore 会影响 git 本身）。
 */

import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { GlobMatcher, createGlobTool, globToRegExp } from "./glob.js";
import { isIgnoredBy, parseIgnoreFile, parseIgnoreLine, walk } from "./ignore.js";
import { createGrepTool, formatFileHits } from "./grep.js";

let tmp: { dir: string; cleanup(): void };
let root: string;

const TREE: Record<string, string> = {
  ".git/HEAD": "ref: refs/heads/main\n",
  ".gitignore": "node_modules/\n*.log\n/build\n!keep.log\ndocs/**/*.tmp\n",
  ".ignore": "secret.txt\n",
  "README.md": "# Title\nhello world\n",
  "keep.log": "kept log TODO\n",
  "debug.log": "ignored TODO\n",
  "secret.txt": "TODO secret\n",
  "build/out.js": "TODO built\n",
  "node_modules/pkg/index.js": "TODO dep\n",
  "src/a.ts": "export const a = 1; // TODO first\nconst x = 2;\n// TODO second\n",
  "src/b.tsx": "TODO tsx\n",
  "src/nested/c.ts": "line1\nline2 TODO\nline3\nline4\nline5\nline6 TODO\n",
  "src/nested/.gitignore": "generated.ts\n",
  "src/nested/generated.ts": "TODO generated\n",
  "src/build/keep.ts": "not root build TODO\n",
  "docs/a/b/x.tmp": "tmp\n",
  "docs/a/b/x.md": "md TODO\n",
  "bin.dat": "TODO\0binary",
};

function writeTree(base: string): void {
  for (const [rel, content] of Object.entries(TREE)) {
    const path = join(base, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

beforeAll(() => {
  tmp = makeTmpDir("ama-search-");
  root = join(tmp.dir, "repo");
  writeTree(root);
  // Windows 建符号链接需要特权，跳过（目录链接不跟随的断言在 POSIX 上覆盖）。
  if (process.platform !== "win32") symlinkSync(join(root, "src"), join(root, "src-link"));
  const t = Date.now() / 1000;
  utimesSync(join(root, "src/a.ts"), t - 100, t - 100);
  utimesSync(join(root, "src/nested/c.ts"), t - 10, t - 10);
  utimesSync(join(root, "src/build/keep.ts"), t - 50, t - 50);
});
afterAll(() => tmp.cleanup());

describe("glob 语法", () => {
  const m = (p: string, s: string) => globToRegExp(p).test(s);
  it("* ? ** [] {} 与转义", () => {
    expect(m("*.ts", "a.ts")).toBe(true);
    expect(m("*.ts", "a/b.ts")).toBe(false);
    expect(m("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(m("src/**/*.ts", "src/x/y/a.ts")).toBe(true);
    expect(m("**", "a/b/c")).toBe(true);
    expect(m("a?c", "abc")).toBe(true);
    expect(m("a?c", "a/c")).toBe(false);
    expect(m("[ab].txt", "b.txt")).toBe(true);
    expect(m("[!ab].txt", "c.txt")).toBe(true);
    expect(m("[!ab].txt", "a.txt")).toBe(false);
    expect(m("*.{ts,tsx}", "x.tsx")).toBe(true);
    expect(m("{src,lib}/{a,b{1,2}}.js", "lib/b2.js")).toBe(true);
    expect(m("\\*.md", "*.md")).toBe(true);
    expect(m("a.{x", "a.{x")).toBe(true);
  });

  it("GlobMatcher：无 / 匹配文件名，! 排除", () => {
    const g = new GlobMatcher(["*.ts", "!**/nested/**"], { nocase: false });
    expect(g.matches("src/a.ts")).toBe(true);
    expect(g.matches("src/nested/c.ts")).toBe(false);
    expect(new GlobMatcher("!*.md").matches("x.ts")).toBe(true);
    expect(new GlobMatcher("*.TS", { nocase: true }).matches("a.ts")).toBe(true);
  });
});

describe("ignore 规则", () => {
  it("否定、目录规则、锚定、**", () => {
    const rules = parseIgnoreFile("*.log\n!keep.log\nbuild/\n/top\na/**/z\n# c\n\\#lit\n", "/r");
    expect(isIgnoredBy(rules, "/r/x.log", false)).toBe(true);
    expect(isIgnoredBy(rules, "/r/sub/keep.log", false)).toBe(false);
    expect(isIgnoredBy(rules, "/r/sub/build", true)).toBe(true);
    expect(isIgnoredBy(rules, "/r/sub/build", false)).toBe(false);
    expect(isIgnoredBy(rules, "/r/top", false)).toBe(true);
    expect(isIgnoredBy(rules, "/r/sub/top", false)).toBe(false);
    expect(isIgnoredBy(rules, "/r/a/z", false)).toBe(true);
    expect(isIgnoredBy(rules, "/r/a/b/c/z", false)).toBe(true);
    expect(isIgnoredBy(rules, "/r/#lit", false)).toBe(true);
    expect(isIgnoredBy(rules, "/other/x.log", false)).toBe(false);
    expect(parseIgnoreLine("   ", "/r")).toBeUndefined();
    expect(parseIgnoreLine("trailing\\ ", "/r")?.regex.test("trailing ")).toBe(true);
  });

  it("walk 尊重嵌套 .gitignore / .ignore，跳过 .git 与目录链接", async () => {
    const files: string[] = [];
    for await (const e of walk(root)) if (!e.isDir) files.push(e.rel);
    expect(files.sort()).toEqual(
      [
        ".gitignore",
        ".ignore",
        "README.md",
        "bin.dat",
        "docs/a/b/x.md",
        "keep.log",
        "src/a.ts",
        "src/b.tsx",
        "src/build/keep.ts",
        "src/nested/.gitignore",
        "src/nested/c.ts",
      ].sort(),
    );
  });

  it("从子目录开始遍历时祖先 ignore 仍生效", async () => {
    const files: string[] = [];
    for await (const e of walk(join(root, "src/nested"))) files.push(e.rel);
    expect(files.sort()).toEqual([".gitignore", "c.ts"]);
  });

  it("respectIgnore: false 时全部列出（.git 仍跳过）", async () => {
    const files: string[] = [];
    for await (const e of walk(root, { respectIgnore: false })) if (!e.isDir) files.push(e.rel);
    expect(files).toContain("node_modules/pkg/index.js");
    expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
  });
});

describe("glob 工具", () => {
  const tool = createGlobTool();
  it("按 mtime 倒序、尊重 ignore、limit", async () => {
    const ctx = makeToolContext(root);
    const r = await tool.execute({ pattern: "**/*.ts" }, ctx);
    expect(r.content).toBe("src/nested/c.ts\nsrc/build/keep.ts\nsrc/a.ts");
    const limited = await tool.execute({ pattern: "*.ts", limit: 1 }, ctx);
    expect(limited.content).toMatch(/^src\/nested\/c\.ts\n\n\[3 files matched/);
    const none = await tool.execute({ pattern: "*.zzz" }, ctx);
    expect(none.content).toBe("No files found");
    const sub = await tool.execute({ pattern: "*.ts", path: "src/nested" }, ctx);
    expect(sub.content).toBe("src/nested/c.ts");
    expect((await tool.execute({ pattern: "x", path: "README.md" }, ctx)).isError).toBe(true);
  });
});

describe("grep 工具", () => {
  const tool = createGrepTool();
  it("path:line: text，跳过 ignore 与二进制", async () => {
    const r = await tool.execute({ pattern: "TODO" }, makeToolContext(root));
    expect(r.content).toBe(
      [
        "docs/a/b/x.md:1: md TODO",
        "keep.log:1: kept log TODO",
        "src/a.ts:1: export const a = 1; // TODO first",
        "src/a.ts:3: // TODO second",
        "src/b.tsx:1: TODO tsx",
        "src/build/keep.ts:1: not root build TODO",
        "src/nested/c.ts:2: line2 TODO",
        "src/nested/c.ts:6: line6 TODO",
      ].join("\n"),
    );
    expect(r.details).toMatchObject({ matches: 8, files: 6, limited: false });
  });

  it("glob 过滤、ignoreCase、literal、单文件", async () => {
    const ctx = makeToolContext(root);
    const g = await tool.execute({ pattern: "todo", glob: "*.tsx", ignoreCase: true }, ctx);
    expect(g.content).toBe("src/b.tsx:1: TODO tsx");
    const lit = await tool.execute({ pattern: "a = 1;", literal: true }, ctx);
    expect(lit.content).toBe("src/a.ts:1: export const a = 1; // TODO first");
    const one = await tool.execute({ pattern: "line\\d", path: "src/nested/c.ts", limit: 2 }, ctx);
    expect(one.content).toMatch(
      /^src\/nested\/c\.ts:1: line1\nsrc\/nested\/c\.ts:2: line2 TODO\n\n\[Stopped at 2 matches/,
    );
    expect((await tool.execute({ pattern: "(" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ pattern: "zzz_nothing" }, ctx)).content).toBe("No matches found");
  });

  it("上下文行与分组分隔", async () => {
    const r = await tool.execute(
      { pattern: "TODO", path: "src/nested/c.ts", context: 1 },
      makeToolContext(root),
    );
    expect(r.content).toBe(
      [
        "src/nested/c.ts-1- line1",
        "src/nested/c.ts:2: line2 TODO",
        "src/nested/c.ts-3- line3",
        "--",
        "src/nested/c.ts-5- line5",
        "src/nested/c.ts:6: line6 TODO",
      ].join("\n"),
    );
  });

  it("limit 跨文件截停", async () => {
    const r = await tool.execute({ pattern: "TODO", limit: 3 }, makeToolContext(root));
    expect((r.content as string).split("\n\n")[0]?.split("\n")).toHaveLength(3);
    expect(r.details).toMatchObject({ matches: 3, limited: true });
  });

  it("[S-A] filesOnly：命中文件去重、按路径排序；与 glob / path / limit 组合；context 不生效", async () => {
    const ctx = makeToolContext(root);
    const all = await tool.execute({ pattern: "TODO", filesOnly: true, context: 2 }, ctx);
    expect(all.content).toBe(
      [
        "docs/a/b/x.md",
        "keep.log",
        "src/a.ts",
        "src/b.tsx",
        "src/build/keep.ts",
        "src/nested/c.ts",
      ].join("\n"),
    );
    expect(all.details).toMatchObject({ files: 6, filesOnly: true, limited: false });
    const ts = await tool.execute({ pattern: "TODO", filesOnly: true, glob: "*.ts" }, ctx);
    expect(ts.content).toBe(["src/a.ts", "src/build/keep.ts", "src/nested/c.ts"].join("\n"));
    const sub = await tool.execute({ pattern: "TODO", filesOnly: true, path: "src/nested" }, ctx);
    expect(sub.content).toBe("src/nested/c.ts");
    const one = await tool.execute(
      { pattern: "line", filesOnly: true, path: "src/nested/c.ts" },
      ctx,
    );
    expect(one.content).toBe("src/nested/c.ts");
    const cut = await tool.execute({ pattern: "TODO", filesOnly: true, limit: 2 }, ctx);
    expect(cut.content).toBe(
      "docs/a/b/x.md\nkeep.log\n\n[Stopped at 2 files. Narrow the search or raise limit.]",
    );
    expect(cut.details).toMatchObject({ files: 2, limited: true });
    const none = await tool.execute({ pattern: "zzz_nothing", filesOnly: true }, ctx);
    expect(none.content).toBe("No matches found");
    expect(none.details).toMatchObject({ matches: 0, files: 0 });
  });

  it("formatFileHits 截断长行", () => {
    const out = formatFileHits("f", { lines: ["x".repeat(600)], hits: [0] }, 0, 10);
    expect(out.text[0]).toMatch(/^f:1: x{500}… \[100 more chars\]$/);
  });
});
