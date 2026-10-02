/**
 * `scripts/check-i18n.mjs`（docs/wave6-plan.md §5.4）：注释剥离、棘轮比较、目录检查、顶层 msg() 检查。[W6-C0]
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface CheckI18n {
  isScanned(path: string): boolean;
  stripComments(source: string): string;
  cjkLines(source: string, path?: string): number[];
  checkCatalog(source: string, path: string): string[];
  eagerMsgLines(source: string): number[];
  compare(
    counts: Record<string, number>,
    baseline: Record<string, number>,
    options?: { strict?: boolean },
  ): { errors: string[]; lowered: string[] };
  scan(): { counts: Record<string, number>; problems: string[] };
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

  it("白名单：输入别名", async () => {
    const { cjkLines } = await load();
    expect(cjkLines('  批准: "pre",', "src/plan/controller.ts")).toEqual([]);
    expect(cjkLines('  批准: "pre",', "src/other.ts")).toEqual([1]);
  });

  it("棘轮：只许降不许升，基线外的新文件必须为 0；严格模式全部失败", async () => {
    const { compare } = await load();
    expect(compare({ "src/a.ts": 3 }, { "src/a.ts": 3 })).toEqual({ errors: [], lowered: [] });
    expect(compare({ "src/a.ts": 2 }, { "src/a.ts": 3 }).lowered).toEqual(["src/a.ts: 3 → 2"]);
    expect(compare({}, { "src/a.ts": 3 }).lowered).toEqual(["src/a.ts: 3 → 0"]);
    expect(compare({ "src/a.ts": 4 }, { "src/a.ts": 3 }).errors).toHaveLength(1);
    expect(compare({ "src/new.ts": 1 }, {}).errors[0]).toContain("src/new.ts");
    expect(compare({ "src/a.ts": 3 }, { "src/a.ts": 3 }, { strict: true }).errors).toHaveLength(1);
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

  it("仓库当前通过（基线、目录、顶层 msg()）", async () => {
    const { scan, compare } = await load();
    const { counts, problems } = scan();
    expect(problems).toEqual([]);
    const { readFileSync } = await import("node:fs");
    const baseline = JSON.parse(
      readFileSync(new URL("../scripts/i18n-baseline.json", import.meta.url), "utf8"),
    ) as { files: Record<string, number> };
    expect(compare(counts, baseline.files).errors).toEqual([]);
  });
});
