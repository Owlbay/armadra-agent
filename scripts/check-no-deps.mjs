#!/usr/bin/env node
// 零运行时依赖守卫（设计 §1.1、§2、D2）：
//   1. package.json 的 dependencies / optionalDependencies / peerDependencies / bundleDependencies 必须为空；
//   2. src/** 非测试源码的 import / export from / import() / require() 只允许 `node:*` 与相对路径。
// 测试文件（*.test.ts）不进产物，允许 import vitest，跳过。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const field of [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
]) {
  const value = pkg[field];
  const count = Array.isArray(value) ? value.length : value ? Object.keys(value).length : 0;
  if (count > 0) problems.push(`package.json: ${field} 必须为空（当前 ${count} 项）`);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (
      /\.(c|m)?tsx?$|\.(c|m)?js$/.test(entry.name) &&
      !/\.test\.(c|m)?tsx?$/.test(entry.name)
    )
      yield full;
  }
}

/** 去掉注释，保留字符串（import 说明符就在字符串里）；按行号对齐。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

const SPECIFIER_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function isAllowed(spec) {
  return spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");
}

let scanned = 0;
for (const file of walk(join(root, "src"))) {
  scanned++;
  const text = stripComments(readFileSync(file, "utf8"));
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1];
      if (spec === undefined || isAllowed(spec)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(
        `${relative(root, file)}:${line}: 不允许的 import "${spec}"（只允许 node:* 与相对路径）`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`check-no-deps: ${p}`);
  process.exit(1);
}
console.log(`check-no-deps: ok（${scanned} 个源文件，dependencies 为空）`);
