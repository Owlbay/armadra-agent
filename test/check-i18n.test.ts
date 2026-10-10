/**
 * `scripts/check-i18n.mjs`（docs/history/wave6-plan.md §5.4）：注释剥离、严格检查（[W6-I5]：出现即失败）、白名单理由、
 * 目录检查、顶层 msg() 检查。[W6-C0]
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface CheckI18n {
  isScanned(path: string): boolean;
  stripComments(source: string): string;
  cjkLines(source: string, path?: string): number[];
  checkCatalog(source: string, path: string): string[];
  eagerMsgLines(source: string): number[];
  scan(): { lines: string[]; problems: string[] };
  SKIPPED: [RegExp, string][];
  ALLOWED_LINES: Record<string, [RegExp, string][]>;
}

const SCRIPT = fileURLToPath(new URL("../scripts/check-i18n.mjs", import.meta.url));
const load = (): Promise<CheckI18n> => import(pathToFileURL(SCRIPT).href) as Promise<CheckI18n>;

describe("check-i18n", () => {
  it("只扫非测试源码，跳过 src/i18n 与生成数据", async () => {
    const { isScanned } = await load();
    expect(isScanned("src/cli/args.ts")).toBe(true);
    expect(isScanned("src/cli/args.test.ts")).toBe(false);
    expect(isScanned("src/i18n/messages/cli.ts")).toBe(false);
    expect(isScanned("src/agent/testing/fake.ts")).toBe(false);
    expect(isScanned("src/modes/interactive/test-support.ts")).toBe(false);
    expect(isScanned("src/ai/providers/models-dev-data.ts")).toBe(false);
    // 价格覆盖数据要扫：只有 _reason 行在白名单里
    expect(isScanned("src/ai/providers/catalog-data.ts")).toBe(true);
    expect(isScanned("scripts/x.ts")).toBe(false);
  });

  it("注释里的汉字不算，字符串 / 模板 / 正则里的算", async () => {
    const { cjkLines } = await load();
    const source = [
      "// 行注释",
      "/** 块注释",
      " * 第二行 */",
      'const a = "中文"; // 尾注释',
      "const b = `模板 ${x ? `嵌套${y}` : '单引号'}`;",
      "const c = 1 / 2; const d = /步骤/;",
      "const e = 'it\\'s'; /* 中 */ const f = 3;",
      "const url = 'http://example.com'; const g = '汉';",
    ].join("\n");
    expect(cjkLines(source)).toEqual([4, 5, 6, 8]);
  });

  it("白名单：输入别名与 _reason，只对登记的文件生效", async () => {
    const { cjkLines } = await load();
    expect(cjkLines('  批准: "pre",', "src/plan/controller.ts")).toEqual([]);
    expect(cjkLines('  批准: "pre",', "src/other.ts")).toEqual([1]);
    const data = `  '{"id":"x","_reason":"按官方价格页"}',`;
    expect(cjkLines(data, "src/ai/providers/catalog-data.ts")).toEqual([]);
    expect(cjkLines(`  '{"id":"x","name":"中文"}',`, "src/ai/providers/catalog-data.ts")).toEqual([
      1,
    ]);
  });

  it("每条跳过与白名单都写了理由", async () => {
    const { SKIPPED, ALLOWED_LINES } = await load();
    for (const [re, reason] of SKIPPED) expect(reason.length, String(re)).toBeGreaterThan(4);
    for (const entries of Object.values(ALLOWED_LINES))
      for (const [re, reason] of entries) expect(reason.length, String(re)).toBeGreaterThan(4);
  });

  it("目录：en 不得有汉字，zh 不得留 TODO", async () => {
    const { checkCatalog } = await load();
    const ok = 'export const en = { a: "A" };\nexport const zh = { a: "甲" } satisfies X;';
    expect(checkCatalog(ok, "m.ts")).toEqual([]);
    expect(checkCatalog('export const en = { a: "甲" };\nexport const zh = {};', "m.ts")).toEqual([
      "m.ts: en 目录里有汉字",
    ]);
    expect(
      checkCatalog('export const en = { a: "A" };\nexport const zh = { a: "TODO" };', "m.ts"),
    ).toEqual(["m.ts: zh 目录里留有 TODO 占位"]);
    // en 的注释里写中文说明可以
    expect(
      checkCatalog(
        'export const en = {\n  // 审批框\n  a: "A",\n};\nexport const zh = {};',
        "m.ts",
      ),
    ).toEqual([]);
  });

  it("顶层常量立即调用 msg() 要报；函数 / getter 里调用不报", async () => {
    const { eagerMsgLines } = await load();
    expect(eagerMsgLines("const HELP = msg().cli.help;")).toEqual([1]);
    expect(eagerMsgLines("x;\nexport const TABLE = {\n  a: msg().cli.a,\n};")).toEqual([3]);
    expect(eagerMsgLines("export const help = () => msg().cli.help;")).toEqual([]);
    expect(eagerMsgLines("export function help() {\n  const m = msg();\n}")).toEqual([]);
    expect(eagerMsgLines("export const T = { get label() { return msg().cli.a; } };")).toEqual([]);
  });

  it("仓库当前通过（严格：没有汉字行、目录、顶层 msg()）", async () => {
    const { scan } = await load();
    const { lines, problems } = scan();
    expect(problems).toEqual([]);
    expect(lines).toEqual([]);
  });
});
