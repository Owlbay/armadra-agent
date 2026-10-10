#!/usr/bin/env node
// 文档链接检查（Issue #201）。零依赖，进 `pnpm run ci`（`pnpm check:docs`）。
//
// 1. 仓库内全部 Markdown（跳过 node_modules、dist、.git）的相对链接：`](target)`、引用定义 `[x]: target`、
//    HTML `src` / `href` / `srcset`。目标文件或目录必须存在；带 `#锚点` 且目标是 Markdown 时，锚点要能在
//    目标文件的标题（GitHub 规则）或 `<a id|name>` 里找到。外链与围栏 / 行内代码里的内容不查。
// 2. 源码注释（src、test、scripts 下的 .ts / .mts / .mjs / .js / .cjs，以及 .github 下 YAML 的 `#` 注释）里
//    出现的 `docs/…md` 路径必须存在（相对仓库根）。字符串里的路径不查：测试样本可以随意写。
//
// 纯函数导出给 test/docs-links.test.ts；CLI 只负责遍历与输出（`--root <dir>` 换仓库根，测试用）。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);
const SOURCE_DIRS = ["src", "test", "scripts"];
const SOURCE_EXTS = new Set([".ts", ".mts", ".mjs", ".js", ".cjs"]);

/** 把围栏代码块替换成等量空行（保留行号）。 */
function blankFences(text) {
  return text.replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1[^\n]*$/gm, (block) =>
    block.replace(/[^\n]/g, ""),
  );
}

/** 去掉行内代码（同一行内的成对反引号）。 */
function stripInlineCode(line) {
  return line.replace(/(`+)[^`]*?\1/g, "");
}

/**
 * Markdown 里的相对链接候选，按出现顺序。
 * @param {string} markdown
 * @returns {{ target: string, line: number }[]}
 */
export function linkTargets(markdown) {
  const out = [];
  const lines = blankFences(markdown).split("\n");
  lines.forEach((raw, index) => {
    const line = stripInlineCode(raw);
    const push = (target) => {
      if (target) out.push({ target, line: index + 1 });
    };
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) push(m[1]);
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/.exec(line);
    if (def) push(def[1]);
    for (const m of line.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) push(m[1]);
    for (const m of line.matchAll(/\bsrcset\s*=\s*"([^"]+)"/g))
      for (const part of (m[1] ?? "").split(",")) push(part.trim().split(/\s+/)[0]);
  });
  return out;
}

/** GitHub 的标题锚点：小写、去掉字母数字空格连字符下划线以外的字符、空格换成 `-`，重名加 `-1`…；另收 `<a id|name>`。 */
export function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  const text = blankFences(markdown);
  for (const m of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = (m[1] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of text.matchAll(/<a\s+[^>]*\b(?:id|name)\s*=\s*"([^"]+)"/g)) anchors.add(m[1]);
  return anchors;
}

/**
 * 源码里的注释文本，按行（非注释部分替换为空串，保留行号）。
 * 行注释 `//` 前必须是行首或空白（不把 `https://` 当注释）；块注释可跨行。YAML 只认 `#` 开头的行。
 * @param {string} source
 * @param {string} ext 扩展名（含点）
 * @returns {string[]}
 */
export function commentLines(source, ext) {
  const lines = source.split("\n");
  if (ext === ".yml" || ext === ".yaml")
    return lines.map((line) => (/^\s*#/.test(line) ? line : ""));
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    let comment = "";
    let i = 0;
    let quote = "";
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        comment += line.slice(i, end === -1 ? line.length : end);
        if (end === -1) break;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const ch = line[i];
      if (quote) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = "";
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        i += 1;
        continue;
      }
      if (line.startsWith("/*", i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (line.startsWith("//", i) && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
        comment += line.slice(i + 2);
        break;
      }
      i += 1;
    }
    out.push(comment);
  }
  return out;
}

/** 文本里相对仓库根的 `docs/…md` 路径（前面不能紧跟路径字符，排除 `foo/docs/x.md`）。 */
export function docPaths(text) {
  return [...text.matchAll(/(?<![\w./-])docs\/[\w./-]*?\.md\b/g)].map((m) => m[0]);
}

function* walk(dir, root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, root);
    else if (entry.isFile()) yield relative(root, full).split(sep).join("/");
  }
}

const anchorCache = new Map();
function anchorsOf(path) {
  let set = anchorCache.get(path);
  if (set === undefined) {
    set = headingAnchors(readFileSync(path, "utf8"));
    anchorCache.set(path, set);
  }
  return set;
}

/**
 * 一个 Markdown 文件里断掉的链接。
 * @param {string} root 仓库根
 * @param {string} file 相对仓库根（`/` 分隔）
 * @returns {string[]}
 */
export function brokenLinksIn(root, file) {
  const source = readFileSync(join(root, file), "utf8");
  const broken = [];
  for (const { target, line } of linkTargets(source)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    const hash = target.indexOf("#");
    const pathPart = (hash === -1 ? target : target.slice(0, hash)).split("?")[0] ?? "";
    const anchor = hash === -1 ? undefined : target.slice(hash + 1);
    const resolved =
      pathPart === ""
        ? join(root, file)
        : pathPart.startsWith("/")
          ? join(root, decodeURIComponent(pathPart))
          : resolve(root, dirname(file), decodeURIComponent(pathPart));
    const where = `${file}:${line}`;
    if (!resolved.startsWith(resolve(root)) || !existsSync(resolved)) {
      broken.push(`${where}: ${target}（文件不存在）`);
      continue;
    }
    if (anchor === undefined || anchor === "") continue;
    if (statSync(resolved).isDirectory() || extname(resolved) !== ".md") continue;
    if (!anchorsOf(resolved).has(decodeURIComponent(anchor).toLowerCase()))
      broken.push(`${where}: ${target}（${relative(root, resolved)} 没有这个标题）`);
  }
  return broken;
}

/**
 * 一个源码文件注释里不存在的 `docs/…md`。
 * @returns {string[]}
 */
export function brokenCommentPathsIn(root, file) {
  const lines = commentLines(readFileSync(join(root, file), "utf8"), extname(file));
  const broken = [];
  lines.forEach((text, index) => {
    for (const path of docPaths(text))
      if (!existsSync(join(root, path))) broken.push(`${file}:${index + 1}: ${path}（文件不存在）`);
  });
  return broken;
}

/** 全仓检查。 */
export function checkDocLinks(root) {
  const files = [...walk(root, root)];
  const problems = [];
  let markdown = 0;
  let sources = 0;
  for (const file of files) {
    if (file.endsWith(".md")) {
      markdown += 1;
      problems.push(...brokenLinksIn(root, file));
      continue;
    }
    const top = file.split("/")[0] ?? "";
    const ext = extname(file);
    const isSource = SOURCE_DIRS.includes(top) && SOURCE_EXTS.has(ext);
    const isWorkflow = top === ".github" && (ext === ".yml" || ext === ".yaml");
    if (!isSource && !isWorkflow) continue;
    sources += 1;
    problems.push(...brokenCommentPathsIn(root, file));
  }
  return { problems, markdown, sources };
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root =
    at === -1 ? join(dirname(fileURLToPath(import.meta.url)), "..") : resolve(args[at + 1] ?? ".");
  const { problems, markdown, sources } = checkDocLinks(root);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`check-doc-links: ✗ ${p}\n`);
    process.stderr.write(`check-doc-links: ${problems.length} 处断链\n`);
    process.exit(1);
  }
  process.stdout.write(`check-doc-links: ok（${markdown} 篇 Markdown，${sources} 个源码文件）\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
