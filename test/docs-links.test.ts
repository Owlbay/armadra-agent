/**
 * `scripts/check-doc-links.mjs`（Issue #201；双语互链规则见 docs/history/wave6-plan.md §5.5、D21）：
 * 提取与锚点规则的正反例、临时目录里的断链检测、本仓库全量通过，以及 README / CHANGELOG / docs/en 的顶部互链。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface DocLinksModule {
  linkTargets(markdown: string): { target: string; line: number }[];
  headingAnchors(markdown: string): Set<string>;
  commentLines(source: string, ext: string): string[];
  docPaths(text: string): string[];
  brokenLinksIn(root: string, file: string): string[];
  brokenCommentPathsIn(root: string, file: string): string[];
  checkDocLinks(root: string): { problems: string[]; markdown: number; sources: number };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "check-doc-links.mjs");
const load = (): Promise<DocLinksModule> =>
  import(pathToFileURL(SCRIPT).href) as Promise<DocLinksModule>;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ama-doc-links-"));
  temps.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("check-doc-links 规则", () => {
  it("标题锚点按 GitHub 规则，重名加序号，另收 <a id>", async () => {
    const { headingAnchors } = await load();
    expect([
      ...headingAnchors(
        "# 为什么做 ama\n## Node 版本、codemode 与沙箱\n## 子 Agent\n## 子 Agent\n",
      ),
    ]).toEqual(["为什么做-ama", "node-版本codemode-与沙箱", "子-agent", "子-agent-1"]);
    expect([...headingAnchors("## Channels: one provider, several endpoints")]).toEqual([
      "channels-one-provider-several-endpoints",
    ]);
    expect([...headingAnchors('```\n# not a heading\n```\n<a id="x-1"></a>\n')]).toEqual(["x-1"]);
  });

  it("链接提取：行内、引用定义与 HTML 属性；代码里的不算", async () => {
    const { linkTargets } = await load();
    const md = [
      "[a](x.md#y) `[b](no.md)`",
      "```",
      "[c](no.md)",
      "```",
      "[d]: https://e.example",
      '<img src="a.svg" alt=""> <source srcset="b.svg 1x, c.svg 2x">',
    ].join("\n");
    expect(linkTargets(md)).toEqual([
      { target: "x.md#y", line: 1 },
      { target: "https://e.example", line: 5 },
      { target: "a.svg", line: 6 },
      { target: "b.svg", line: 6 },
      { target: "c.svg", line: 6 },
    ]);
  });

  it("注释提取：行注释、跨行块注释、YAML 的 #；字符串与 URL 不算", async () => {
    const { commentLines, docPaths } = await load();
    const ts = [
      'const a = "// docs/a.md"; // see docs/b.md',
      "/* docs/c.md",
      " * docs/d.md */ const u = 'https://x/docs/e.md';",
    ].join("\n");
    const lines = commentLines(ts, ".ts");
    expect(lines.flatMap((line) => docPaths(line))).toEqual([
      "docs/b.md",
      "docs/c.md",
      "docs/d.md",
    ]);
    expect(commentLines("# docs/f.md\nrun: cat docs/g.md\n", ".yml").flatMap(docPaths)).toEqual([
      "docs/f.md",
    ]);
    expect(docPaths("x/docs/h.md docs/en/guides/tui.md")).toEqual(["docs/en/guides/tui.md"]);
  });

  it("临时仓库：报出不存在的文件、锚点与注释路径，带行号", async () => {
    const { checkDocLinks } = await load();
    const dir = repo({
      "README.md": "# Top\n\n[ok](docs/a.md#intro)\n[bad](docs/a.md#nope)\n[gone](docs/b.md)\n",
      "docs/a.md": "# Intro\n\n[up](../README.md#top) [self](#intro) [dir](./)\n",
      "src/x.ts": "// docs/a.md and docs/missing.md\nexport const s = 'docs/also-missing.md';\n",
      "node_modules/pkg/README.md": "[x](nowhere.md)\n",
    });
    const result = checkDocLinks(dir);
    expect(result.problems).toEqual([
      "README.md:4: docs/a.md#nope（docs/a.md 没有这个标题）",
      "README.md:5: docs/b.md（文件不存在）",
      "src/x.ts:1: docs/missing.md（文件不存在）",
    ]);
    expect(result.markdown).toBe(2);
    expect(result.sources).toBe(1);
  });
});

describe("本仓库的文档链接", () => {
  it("全部 Markdown 的相对链接与锚点、源码注释里的 docs 路径都存在", async () => {
    const { checkDocLinks } = await load();
    expect(checkDocLinks(ROOT).problems).toEqual([]);
  });

  const enDocs = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".md") && entry.name !== "README.md") out.push(full);
      }
    };
    walk(join(ROOT, "docs", "en"));
    return out;
  };

  it("README / CHANGELOG / docs/en 顶部互链", () => {
    const top = (file: string) =>
      readFileSync(resolve(ROOT, file), "utf8").split("\n").slice(0, 10).join("\n");
    expect(top("README.md")).toContain("[简体中文](README.zh-CN.md)");
    expect(top("README.zh-CN.md")).toContain("[English](README.md)");
    expect(top("CHANGELOG.md")).toContain("[简体中文](CHANGELOG.zh-CN.md)");
    expect(top("CHANGELOG.zh-CN.md")).toContain("[English](CHANGELOG.md)");
    for (const file of enDocs()) {
      // docs/en/<分层>/<篇>.md ↔ docs/<分层>/<篇>.md
      const rel = relative(join(ROOT, "docs", "en"), file)
        .split(/[\\/]/)
        .join("/");
      expect(top(file), rel).toContain(`[简体中文](../../${rel})`);
      expect(existsSync(join(ROOT, "docs", rel)), rel).toBe(true);
    }
  });

  it("docs/en 含首批六篇与 acp，按分层放", () => {
    const names = enDocs().map((file) =>
      relative(join(ROOT, "docs", "en"), file)
        .split(/[\\/]/)
        .join("/"),
    );
    for (const name of [
      "reference/acp.md",
      "reference/host-api.md",
      "guides/permissions.md",
      "guides/providers.md",
      "reference/rpc.md",
      "guides/sessions.md",
      "guides/tui.md",
    ])
      expect(names, name).toContain(name);
  });
});
