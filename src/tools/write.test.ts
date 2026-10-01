import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { conformToOriginal, createWriteTool } from "./write.js";

let tmp: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => tmp.cleanup());

describe("write", () => {
  const tool = createWriteTool();

  it("新建文件并建父目录", async () => {
    const ctx = makeToolContext(tmp.dir);
    const r = await tool.execute({ path: "a/b/c.txt", content: "hi\n" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(tmp.dir, "a/b/c.txt"), "utf8")).toBe("hi\n");
    expect(r.details).toMatchObject({ bytes: 3, created: true });
    expect(ctx.readFiles.has(join(tmp.dir, "a/b/c.txt"))).toBe(true);
  });

  it("已存在而未 read → 错误；read 后可覆盖", async () => {
    const file = join(tmp.dir, "x.txt");
    writeFileSync(file, "old");
    const ctx = makeToolContext(tmp.dir);
    const denied = await tool.execute({ path: "x.txt", content: "new" }, ctx);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("Read it with the read tool");
    expect(readFileSync(file, "utf8")).toBe("old");
    ctx.markRead(file);
    const ok = await tool.execute({ path: "x.txt", content: "new" }, ctx);
    expect(ok.details).toMatchObject({ created: false, bytes: 3 });
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it("保留原文件的 BOM 与 CRLF", async () => {
    const file = join(tmp.dir, "w.txt");
    writeFileSync(file, "\uFEFFa\r\nb\r\n");
    const ctx = makeToolContext(tmp.dir);
    ctx.markRead(file);
    await tool.execute({ path: "w.txt", content: "x\ny\n" }, ctx);
    expect(readFileSync(file, "utf8")).toBe("\uFEFFx\r\ny\r\n");
  });

  it("conformToOriginal 不重复加 BOM / CR", () => {
    expect(conformToOriginal("\uFEFFa\r\n", "\uFEFFb\r\nc")).toBe("\uFEFFb\r\nc");
    expect(conformToOriginal("plain\n", "x\r\ny")).toBe("x\r\ny");
    expect(conformToOriginal("one line", "a\nb")).toBe("a\nb");
  });

  it("目标是目录 → 错误", async () => {
    const r = await tool.execute({ path: ".", content: "x" }, makeToolContext(tmp.dir));
    expect(r.isError).toBe(true);
  });
});
