/**
 * 双语文档的相对链接都能点（docs/wave6-plan.md §5.5、D21）。[W6-I4]
 *
 * 检查 README.md / README.zh-CN.md、两份 CHANGELOG 与 docs/en/*.md 里的相对链接：目标文件存在；
 * 带 `#锚点` 且目标是 Markdown 时，锚点按 GitHub 的规则能在目标文件的标题里找到。外链不查。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function docFiles(): string[] {
  const top = ["README.md", "README.zh-CN.md", "CHANGELOG.md", "CHANGELOG.zh-CN.md"];
  const en = readdirSync(join(ROOT, "docs", "en"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join("docs", "en", name));
  return [...top, ...en];
}

/** 去掉围栏代码块与行内代码（里面的方括号不是链接）。 */
function stripCode(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

/** 行内链接 `](target)` 与引用定义 `[x]: target`。 */
export function linkTargets(markdown: string): string[] {
  const text = stripCode(markdown);
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1] ?? "");
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) out.push(m[1] ?? "");
  return out.filter((t) => t !== "");
}

/** GitHub 的标题锚点：小写、去掉字母数字空格连字符下划线以外的字符、空格换成 `-`，重名加 `-1`… */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const text = markdown.replace(/^```[\s\S]*?^```/gm, "");
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = (m[1] ?? "")
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

function brokenLinks(file: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const broken: string[] = [];
  for (const target of linkTargets(source)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http(s)、mailto 等外链
    const [pathPart = "", anchor] = target.split("#", 2);
    const resolved = pathPart === "" ? join(ROOT, file) : resolve(ROOT, dirname(file), pathPart);
    if (!resolved.startsWith(ROOT) || !existsSync(resolved)) {
      broken.push(`${target}（文件不存在）`);
      continue;
    }
    if (anchor === undefined || anchor === "") continue;
    if (statSync(resolved).isDirectory() || !resolved.endsWith(".md")) continue;
    const anchors = headingAnchors(readFileSync(resolved, "utf8"));
    if (!anchors.has(decodeURIComponent(anchor).toLowerCase()))
      broken.push(`${target}（${relative(ROOT, resolved)} 没有这个标题）`);
  }
  return broken;
}

describe("双语文档的链接", () => {
  it("锚点与链接提取规则", () => {
    expect([
      ...headingAnchors(
        "# 为什么做 ama\n## Node 版本、codemode 与沙箱\n## 子 Agent\n## 子 Agent\n",
      ),
    ]).toEqual(["为什么做-ama", "node-版本codemode-与沙箱", "子-agent", "子-agent-1"]);
    expect([...headingAnchors("## Channels: one provider, several endpoints")]).toEqual([
      "channels-one-provider-several-endpoints",
    ]);
    expect(
      linkTargets("[a](x.md#y) `[b](no.md)`\n```\n[c](no.md)\n```\n[d]: https://e.example\n"),
    ).toEqual(["x.md#y", "https://e.example"]);
  });

  it.each(docFiles())("%s 的相对链接与锚点都存在", (file) => {
    expect(brokenLinks(file)).toEqual([]);
  });

  it("README / CHANGELOG / docs/en 顶部互链", () => {
    const top = (file: string) =>
      readFileSync(join(ROOT, file), "utf8").split("\n").slice(0, 10).join("\n");
    expect(top("README.md")).toContain("[简体中文](README.zh-CN.md)");
    expect(top("README.zh-CN.md")).toContain("[English](README.md)");
    expect(top("CHANGELOG.md")).toContain("[简体中文](CHANGELOG.zh-CN.md)");
    expect(top("CHANGELOG.zh-CN.md")).toContain("[English](CHANGELOG.md)");
    for (const file of docFiles().filter((f) => f.startsWith(join("docs", "en")))) {
      const name = file.split(/[\\/]/).at(-1) ?? "";
      expect(top(file), file).toContain(`[简体中文](../${name})`);
      expect(existsSync(join(ROOT, "docs", name)), file).toBe(true);
    }
  });

  it("docs/en 含首批六篇与 acp", () => {
    const names = readdirSync(join(ROOT, "docs", "en"));
    for (const name of ["acp", "host-api", "permissions", "providers", "rpc", "sessions", "tui"])
      expect(names, name).toContain(`${name}.md`);
  });
});
