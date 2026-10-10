/**
 * 模型侧隔离守卫（docs/history/wave6-plan.md §5.4、D18）。[W6-C0]
 *
 * 给模型的文本固定英文、与界面语言无关：下列模块（系统提示、工具描述与结果、Plan 提示、内置子 Agent、
 * Skill、压缩、codemode 声明、Memory 工具）不得 import `src/i18n`。需要给人看的提示请返回码 / 结构，
 * 由界面层按 `msg()` 渲染（例：`tools/image-file.ts` 抛 `AmaError(code, englishMessage)`）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");
const I18N = join(SRC, "i18n");

/** 模型侧模块：文件或目录（目录递归）。`memory/tool.ts` 由 W6-M 新建，存在时纳入。 */
export const MODEL_SIDE = [
  "agent/system-prompt.ts",
  "agent/prompt-rules.ts",
  "agent/reminders.ts",
  "tools",
  "plan/prompts.ts",
  "agents/builtin.ts",
  "skills",
  "compaction",
  "codemode/declarations.ts",
  "memory/tool.ts",
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield full;
  }
}

function modelSideFiles(): string[] {
  const files: string[] = [];
  for (const item of MODEL_SIDE) {
    const full = join(SRC, item);
    if (!existsSync(full)) continue;
    if (item.endsWith(".ts")) files.push(full);
    else files.push(...walk(full));
  }
  return files;
}

/** 源码里的模块说明符（import / export from / import() / require()）。 */
export function specifiers(source: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|[^\w$.])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[^\w$.])import\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

/** 该文件 import 进 src/i18n 的说明符。 */
export function i18nImports(file: string, source: string): string[] {
  return specifiers(source).filter((spec) => {
    if (!spec.startsWith(".")) return false;
    const target = resolve(dirname(file), spec);
    return target === I18N || target.startsWith(I18N + sep);
  });
}

describe("模型侧不 import src/i18n", () => {
  it("清单里的模块都存在（memory/tool.ts 除外，W6-M 新建）", () => {
    for (const item of MODEL_SIDE.filter((i) => i !== "memory/tool.ts"))
      expect(existsSync(join(SRC, item)), item).toBe(true);
  });

  it("没有违规", () => {
    const files = modelSideFiles();
    expect(files.length).toBeGreaterThan(30);
    const violations = files.flatMap((file) =>
      i18nImports(file, readFileSync(file, "utf8")).map(
        (spec) => `${relative(ROOT, file)} → ${spec}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("能抓到违规：静态 import、type import、export from、动态 import", () => {
    const file = join(SRC, "tools", "fake-tool.ts");
    expect(i18nImports(file, `import { msg } from "../i18n/index.js";\n`)).toEqual([
      "../i18n/index.js",
    ]);
    expect(i18nImports(file, `import type { Locale } from "../i18n/index.js";`)).toHaveLength(1);
    expect(i18nImports(file, `export { msg } from "../i18n/index.js";`)).toHaveLength(1);
    expect(i18nImports(file, `const m = await import("../i18n/messages/cli.js");`)).toHaveLength(1);
    expect(
      i18nImports(join(SRC, "tools", "nested", "x.ts"), `import {\n  msg,\n} from "../../i18n";`),
    ).toHaveLength(1);
    // 不相干的路径不算
    expect(i18nImports(file, `import { x } from "./i18n-helpers.js";`)).toEqual([]);
    expect(i18nImports(file, `import { x } from "../agent/types.js";`)).toEqual([]);
  });
});
