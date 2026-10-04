import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { EditError, createEditTool, fileChangeOf, planEdits, unifiedDiff } from "./edit.js";
import { FILE_CHANGE_TEXT_LIMIT } from "./types.js";
import {
  applyPreservingLines,
  detectLineEnding,
  findAll,
  lineNumberAt,
  normalizeForFuzzy,
} from "./edit-fuzzy.js";

let tmp: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => tmp.cleanup());

function plan(content: string, edits: { oldText: string; newText: string }[], all = false) {
  return planEdits(content, edits, all);
}

describe("planEdits", () => {
  it("多处替换都在原文上匹配", () => {
    const r = plan("a b c", [
      { oldText: "a", newText: "b" },
      { oldText: "b", newText: "a" },
    ]);
    expect(r.result).toBe("b a c");
    expect(r.replacements).toBe(2);
    expect(r.fuzzy).toBe(false);
  });

  it("不唯一 → 错误含次数与首两处行号", () => {
    expect(() => plan("x\ny\nx\nx\n", [{ oldText: "x", newText: "z" }])).toThrow(
      /matches 3 times \(first at lines 1 and 3\)/,
    );
  });

  it("replaceAll 替换全部", () => {
    expect(plan("x y x", [{ oldText: "x", newText: "z" }], true).result).toBe("z y z");
  });

  it("重叠 → 错误", () => {
    expect(() =>
      plan("abcdef", [
        { oldText: "abc", newText: "1" },
        { oldText: "cde", newText: "2" },
      ]),
    ).toThrow(/overlap/);
  });

  it("找不到 / 空 oldText / 无变化 → 错误", () => {
    expect(() => plan("abc", [{ oldText: "zzz", newText: "1" }])).toThrow(EditError);
    expect(() => plan("abc", [{ oldText: "", newText: "1" }])).toThrow(/must not be empty/);
    expect(() => plan("abc", [{ oldText: "b", newText: "b" }])).toThrow(/no change/);
    expect(() => plan("abc", [])).toThrow(/at least one/);
  });

  it("模糊回退：弯引号、破折号、行尾空白；未触及的行保留原字节", () => {
    const content = "keep “this”   \nconst s = ‘hi’;  \nend — here\n";
    const r = plan(content, [{ oldText: "const s = 'hi';", newText: "const s = 'bye';" }]);
    expect(r.fuzzy).toBe(true);
    expect(r.result).toBe("keep “this”   \nconst s = 'bye';\nend — here\n");
  });

  it("模糊匹配 NFKC（全角字符）", () => {
    const r = plan("value = ＡＢＣ\n", [{ oldText: "value = ABC", newText: "value = X" }]);
    expect(r.result).toBe("value = X\n");
  });
});

describe("edit-fuzzy 工具函数", () => {
  it("detectLineEnding / findAll / lineNumberAt / normalize", () => {
    expect(detectLineEnding("a\r\nb")).toBe("\r\n");
    expect(detectLineEnding("a\nb\r\n")).toBe("\n");
    expect(detectLineEnding("a")).toBe("\n");
    expect(findAll("aaaa", "aa")).toEqual([0, 2]);
    expect(lineNumberAt("a\nb\nc", 4)).toBe(3);
    expect(normalizeForFuzzy("a b–c  ")).toBe("a b-c");
  });

  it("applyPreservingLines 行数不一致时退回整段替换", () => {
    expect(applyPreservingLines("a\nb", "a", [{ index: 0, length: 1, newText: "z" }])).toBe("z");
  });
});

describe("unifiedDiff", () => {
  it("给出 hunk 头与 +/- 行", () => {
    const d = unifiedDiff("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n", "f.txt", 1);
    expect(d).toBe(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -1,4 +1,5 @@", " a", "-b", "+B", " c", " d", "+e"].join(
        "\n",
      ),
    );
    expect(unifiedDiff("same", "same", "f")).toBe("");
  });

  it("相距远的修改分成两个 hunk", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const b = a.replace("l1\n", "L1\n").replace("l18", "L18");
    const d = unifiedDiff(a, b, "f", 2);
    expect(d.match(/^@@/gm)?.length).toBe(2);
  });
});

describe("edit 工具", () => {
  const tool = createEditTool();

  it("要求先 read", async () => {
    writeFileSync(join(tmp.dir, "a.txt"), "hello");
    const r = await tool.execute(
      { path: "a.txt", edits: [{ oldText: "hello", newText: "bye" }] },
      makeToolContext(tmp.dir),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("before editing");
  });

  it("保留 BOM 与 CRLF，details 带 diff", async () => {
    const file = join(tmp.dir, "w.txt");
    writeFileSync(file, "\uFEFFone\r\ntwo\r\nthree\r\n");
    const ctx = makeToolContext(tmp.dir);
    ctx.markRead(file);
    const r = await tool.execute(
      { path: "w.txt", edits: [{ oldText: "two\nthree", newText: "2\n3" }] },
      ctx,
    );
    expect(r.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("\uFEFFone\r\n2\r\n3\r\n");
    const details = r.details as { diff: string; firstChangedLine: number; replacements: number };
    expect(details.diff).toContain("-two");
    expect(details.diff).toContain("+2");
    expect(details.firstChangedLine).toBe(2);
    expect(details.replacements).toBe(1);
    // fileChange 是磁盘原文（BOM / CRLF 原样），首个改动行同 details
    expect(r.fileChange).toEqual({
      path: file,
      oldText: "\uFEFFone\r\ntwo\r\nthree\r\n",
      newText: "\uFEFFone\r\n2\r\n3\r\n",
      firstChangedLine: 2,
    });
  });

  it("fileChange：任一侧超过上限不填，编辑照常成功；失败不填", async () => {
    const file = join(tmp.dir, "big.txt");
    writeFileSync(file, `head\n${"x".repeat(FILE_CHANGE_TEXT_LIMIT)}\n`);
    const ctx = makeToolContext(tmp.dir);
    ctx.markRead(file);
    const r = await tool.execute(
      { path: "big.txt", edits: [{ oldText: "head", newText: "top" }] },
      ctx,
    );
    expect(r.isError).toBeUndefined();
    expect(r.fileChange).toBeUndefined();
    expect(readFileSync(file, "utf8").startsWith("top\n")).toBe(true);
    const failed = await tool.execute(
      { path: "big.txt", edits: [{ oldText: "absent", newText: "y" }] },
      ctx,
    );
    expect(failed.isError).toBe(true);
    expect(failed.fileChange).toBeUndefined();
  });

  it("fileChangeOf：单侧上限、新文件 oldText null", () => {
    const max = "a".repeat(FILE_CHANGE_TEXT_LIMIT);
    expect(fileChangeOf("/p", max, max, 1)).toEqual({
      path: "/p",
      oldText: max,
      newText: max,
      firstChangedLine: 1,
    });
    expect(fileChangeOf("/p", `${max}b`, "x")).toBeUndefined();
    expect(fileChangeOf("/p", "x", `${max}b`)).toBeUndefined();
    expect(fileChangeOf("/p", null, "new")).toEqual({ path: "/p", oldText: null, newText: "new" });
  });

  it("错误不改文件", async () => {
    const file = join(tmp.dir, "e.txt");
    writeFileSync(file, "x x");
    const ctx = makeToolContext(tmp.dir);
    ctx.markRead(file);
    const r = await tool.execute({ path: "e.txt", edits: [{ oldText: "x", newText: "y" }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("matches 2 times");
    expect(readFileSync(file, "utf8")).toBe("x x");
    const missing = await tool.execute({ path: "nope.txt", edits: [] }, ctx);
    expect(missing.isError).toBe(true);
  });
});
