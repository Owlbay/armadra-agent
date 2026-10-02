#!/usr/bin/env node
// 中英双语检查（docs/wave6-plan.md §5.4、D20；docs/i18n.md）。零依赖，进 `pnpm ci`。
//
//   1. 棘轮：扫 src/** 非测试、非 src/i18n/ 源码里「代码与字符串中」含汉字的行（注释不算），按文件计数，与
//      scripts/i18n-baseline.json 比较——只许降不许升，基线里没有的文件必须为 0。白名单：输入别名
//      （plan/controller.ts 的「批准」、plan/extract.ts 的步骤标题正则），两种语言同时识别、与界面语言无关。
//   2. 目录：src/i18n/messages/*.ts 的 `en` 段不得含汉字；`zh` 段不得留 TODO 占位。
//   3. 顶层 `const` / `let` 的初始化不得立即调用 msg()（会按 import 时的语言定死）；放进函数或 getter 里。
//
// 用法：
//   node scripts/check-i18n.mjs            检查（失败退出码 1）
//   node scripts/check-i18n.mjs --update   计数下降后收紧基线（只降；要升需 --force，并在 PR 写明理由）
//   node scripts/check-i18n.mjs --strict   严格模式（[W6-I5]）：任何汉字都失败

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "scripts", "i18n-baseline.json");
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;

/** 不扫的源码：测试、测试支撑、生成数据。 */
export function isScanned(path) {
  const p = path.split(sep).join("/");
  if (!p.startsWith("src/") || !p.endsWith(".ts")) return false;
  if (p.endsWith(".test.ts") || p.endsWith(".d.ts")) return false;
  if (p.startsWith("src/i18n/")) return false;
  if (/(^|\/)(testing|__snapshots__)\//.test(p)) return false;
  if (/(^|\/)test-support\.ts$/.test(p)) return false;
  if (/(^|\/)(models-dev-data|catalog-data)\.ts$/.test(p)) return false;
  return true;
}

/** 输入别名白名单：文件 → 允许的行（正则）。 */
export const ALLOWED_LINES = {
  "src/plan/controller.ts": [/^\s*批准: "pre",\s*$/],
  "src/plan/extract.ts": [
    /^const STEPS_HEADING = \/步骤\|steps\|implementation\|实施\|执行\/i;$/,
    /^\s*\.split\(\/\[,，\\s\]\+\/\)/,
  ],
};

/**
 * 把源码拆成「代码」与「注释」：返回与原文等长的字符串，注释位置换成空格（换行保留）。
 * 足够处理本仓库的写法：字符串、模板字符串（含 `${}` 嵌套）、正则字面量、行 / 块注释。
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  /** 模板字符串里 `${` 的深度栈：每层记录进入时的花括号深度。 */
  const templateStack = [];
  let braceDepth = 0;
  let lastSignificant = "";
  const blank = (text) => text.replace(/[^\n]/g, " ");
  const regexAllowedAfter = new Set([
    "",
    "(",
    ",",
    "=",
    ":",
    "[",
    "!",
    "&",
    "|",
    "?",
    "{",
    "}",
    ";",
    "+",
    "-",
    "*",
    "%",
    "<",
    ">",
    "~",
    "^",
  ]);
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = ch;
      continue;
    }
    if (
      ch === "`" ||
      (ch === "}" && templateStack.length > 0 && templateStack.at(-1) === braceDepth)
    ) {
      // 模板字符串（或 `${…}` 结束后的续段）：读到下一个反引号或 `${`
      if (ch === "}") templateStack.pop();
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "`") break;
        if (source[j] === "$" && source[j + 1] === "{") break;
        j++;
      }
      if (source[j] === "$") {
        templateStack.push(braceDepth);
        out += source.slice(i, j + 2);
        i = j + 2;
        lastSignificant = "{";
        continue;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = "`";
      continue;
    }
    if (ch === "/" && regexAllowedAfter.has(lastSignificant)) {
      // 正则字面量
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = "/";
      continue;
    }
    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    if (!/\s/.test(ch)) {
      lastSignificant = /[A-Za-z0-9_$)\]]/.test(ch) ? "w" : ch;
      if (/[A-Za-z_$]/.test(ch)) {
        // 关键字后面可以跟正则（return /x/）
        const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))[0];
        lastSignificant = [
          "return",
          "typeof",
          "case",
          "in",
          "of",
          "void",
          "yield",
          "await",
        ].includes(word)
          ? ""
          : "w";
        out += word;
        i += word.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** 一个文件里「代码中含汉字」的行号（1 起）；白名单行不算。 */
export function cjkLines(source, path = "") {
  const code = stripComments(source).split("\n");
  const raw = source.split("\n");
  const allowed = ALLOWED_LINES[path] ?? [];
  const lines = [];
  code.forEach((line, index) => {
    if (!CJK.test(line)) return;
    if (allowed.some((re) => re.test(raw[index] ?? ""))) return;
    lines.push(index + 1);
  });
  return lines;
}

/** 消息目录：`export const en = {…}` 与 `export const zh = {…}` 的正文（按花括号配平）。 */
export function catalogSections(source) {
  const code = stripComments(source);
  const sections = {};
  for (const name of ["en", "zh"]) {
    const start = code.search(new RegExp(`export const ${name}\\b[^=]*=\\s*\\{`));
    if (start === -1) continue;
    let depth = 0;
    let i = code.indexOf("{", start);
    const open = i;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) break;
    }
    sections[name] = code.slice(open, i + 1);
  }
  return sections;
}

export function checkCatalog(source, path) {
  const problems = [];
  const { en, zh } = catalogSections(source);
  if (en === undefined || zh === undefined) problems.push(`${path}: 缺 export const en / zh`);
  if (en !== undefined && CJK.test(en)) problems.push(`${path}: en 目录里有汉字`);
  if (zh !== undefined && /\bTODO\b/.test(zh)) problems.push(`${path}: zh 目录里留有 TODO 占位`);
  return problems;
}

/** 顶层 `const` / `let` 初始化里立即调用 msg() 的位置（行号）。 */
export function eagerMsgLines(source) {
  const code = stripComments(source);
  const lines = [];
  const re = /^(?:export\s+)?(?:const|let|var)\s[^\n]*/gm;
  let match;
  while ((match = re.exec(code)) !== null) {
    // 取整条语句：到花括号 / 括号配平后的第一个分号
    let depth = 0;
    let end = match.index;
    for (; end < code.length; end++) {
      const ch = code[end];
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
      else if (ch === ";" && depth === 0) break;
    }
    const statement = code.slice(match.index, end);
    const call = statement.search(/\bmsg\(\)/);
    if (call === -1) continue;
    const before = statement.slice(0, call);
    if (/=>|\bfunction\b|\bget\s+\w+\s*\(/.test(before)) continue;
    lines.push(code.slice(0, match.index + call).split("\n").length);
  }
  return lines;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** 扫描整个仓库：每文件汉字行数 + 其它问题。 */
export function scan(root = ROOT) {
  const counts = {};
  const problems = [];
  for (const full of walk(join(root, "src"))) {
    const path = relative(root, full).split(sep).join("/");
    if (!path.endsWith(".ts")) continue;
    const source = readFileSync(full, "utf8");
    if (path.startsWith("src/i18n/messages/")) problems.push(...checkCatalog(source, path));
    if (!path.endsWith(".test.ts") && !path.startsWith("src/i18n/"))
      for (const line of eagerMsgLines(source))
        problems.push(`${path}:${line}: 顶层常量立即调用 msg()，改成函数或 getter`);
    if (!isScanned(path)) continue;
    const lines = cjkLines(source, path);
    if (lines.length > 0) counts[path] = lines.length;
  }
  return { counts, problems };
}

/** 与基线比较。 */
export function compare(counts, baseline, { strict = false } = {}) {
  const errors = [];
  const lowered = [];
  for (const [path, count] of Object.entries(counts).sort()) {
    const allowed = strict ? 0 : (baseline[path] ?? 0);
    if (count > allowed)
      errors.push(
        `${path}: 界面文案里有 ${count} 行汉字（基线 ${allowed}）——新文案写进 src/i18n/messages/<领域>.ts`,
      );
    else if (count < allowed) lowered.push(`${path}: ${allowed} → ${count}`);
  }
  for (const [path, allowed] of Object.entries(baseline))
    if (!(path in counts) && allowed > 0) lowered.push(`${path}: ${allowed} → 0`);
  return { errors, lowered };
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {};
  } catch {
    return {};
  }
}

function writeBaseline(counts) {
  const files = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
  const total = Object.values(files).reduce((sum, n) => sum + n, 0);
  writeFileSync(BASELINE, `${JSON.stringify({ version: 1, total, files }, null, 2)}\n`);
}

function run(argv) {
  const strict = argv.includes("--strict");
  const { counts, problems } = scan();
  const baseline = readBaseline();
  if (argv.includes("--update")) {
    const raised = compare(counts, baseline).errors;
    if (raised.length > 0 && !argv.includes("--force")) {
      process.stderr.write(
        `基线只降不升；确需上调加 --force 并在 PR 写明理由：\n${raised.join("\n")}\n`,
      );
      return 1;
    }
    writeBaseline(counts);
    process.stdout.write(
      `已写 scripts/i18n-baseline.json（${Object.keys(counts).length} 个文件）\n`,
    );
    return 0;
  }
  const { errors, lowered } = compare(counts, baseline, { strict });
  const all = [...problems, ...errors];
  if (lowered.length > 0)
    process.stdout.write(
      `i18n：以下文件的汉字行减少了，可用 node scripts/check-i18n.mjs --update 收紧基线：\n  ${lowered.join("\n  ")}\n`,
    );
  if (all.length > 0) {
    process.stderr.write(`i18n 检查失败：\n  ${all.join("\n  ")}\n`);
    return 1;
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  process.stdout.write(`i18n 检查通过（剩余 ${total} 行待迁移）\n`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = run(process.argv.slice(2));
}
