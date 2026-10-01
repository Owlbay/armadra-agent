import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { createReadTool, imageSize, isBinary, numberLines } from "./read.js";

let tmp: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => tmp.cleanup());

const PNG_1x2 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000208060000009977a8a40000000d4944415478da63f8ffff3f0005fe02fea7d6a9f30000000049454e44ae426082",
  "hex",
);

describe("read", () => {
  const tool = createReadTool();

  it("cat -n 形状并登记 readFiles", async () => {
    writeFileSync(join(tmp.dir, "a.txt"), "\uFEFFone\r\ntwo\nthree\n");
    const ctx = makeToolContext(tmp.dir);
    const r = await tool.execute({ path: "a.txt" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe("     1\tone\n     2\ttwo\n     3\tthree");
    expect(ctx.readFiles.has(join(tmp.dir, "a.txt"))).toBe(true);
  });

  it("offset / limit 与续读提示", async () => {
    writeFileSync(
      join(tmp.dir, "n.txt"),
      Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"),
    );
    const ctx = makeToolContext(tmp.dir);
    const r = await tool.execute({ path: "n.txt", offset: 3, limit: 2 }, ctx);
    expect(r.content).toBe(
      "     3\tL3\n     4\tL4\n\n[Showing lines 3-4 of 10. Use offset=5 to continue.]",
    );
    const bad = await tool.execute({ path: "n.txt", offset: 11 }, ctx);
    expect(bad.isError).toBe(true);
  });

  it("头截断 2000 行", async () => {
    writeFileSync(
      join(tmp.dir, "big.txt"),
      Array.from({ length: 2500 }, (_, i) => `x${i}`).join("\n"),
    );
    const r = await tool.execute({ path: "big.txt" }, makeToolContext(tmp.dir));
    const text = r.content as string;
    expect(text).toContain("  2000\tx1999");
    expect(text).not.toContain("x2000\n");
    expect(text).toContain("Use offset=2001 to continue.");
    expect(r.details).toMatchObject({ truncated: true, lastLine: 2000 });
  });

  it("头截断 50 KB", async () => {
    const line = "y".repeat(1000);
    writeFileSync(join(tmp.dir, "wide.txt"), Array.from({ length: 100 }, () => line).join("\n"));
    const r = await tool.execute({ path: "wide.txt" }, makeToolContext(tmp.dir));
    expect(Buffer.byteLength(r.content as string)).toBeLessThan(52 * 1024);
    expect(r.content as string).toMatch(
      /output limit 50\.0 KB reached\)\. Use offset=\d+ to continue/,
    );
  });

  it("二进制拒绝、目录与不存在报错、空文件", async () => {
    writeFileSync(join(tmp.dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    mkdirSync(join(tmp.dir, "d"));
    writeFileSync(join(tmp.dir, "empty.txt"), "");
    const ctx = makeToolContext(tmp.dir);
    expect((await tool.execute({ path: "bin.dat" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ path: "d" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ path: "nope" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ path: "empty.txt" }, ctx)).content).toContain("is empty");
    expect(isBinary(Buffer.from("abc"))).toBe(false);
  });

  it("图片作为 ImageBlock；模型不支持时只给尺寸", async () => {
    writeFileSync(join(tmp.dir, "p.png"), PNG_1x2);
    const ctx = makeToolContext(tmp.dir);
    const r = await tool.execute({ path: "p.png" }, ctx);
    expect(Array.isArray(r.content)).toBe(true);
    const blocks = r.content as { type: string; mimeType?: string; text?: string }[];
    expect(blocks[0]?.text).toContain("1x2");
    expect(blocks[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    const noImg = createReadTool({ supportsImages: () => false });
    const r2 = await noImg.execute({ path: "p.png" }, ctx);
    expect(typeof r2.content).toBe("string");
    expect(r2.content).toContain("does not accept image input");
  });

  it("imageSize 认识 gif / jpeg / webp 头", () => {
    const gif = Buffer.from("474946383961" + "0300" + "0500", "hex");
    expect(imageSize(gif, "image/gif")).toEqual({ width: 3, height: 5 });
    const jpeg = Buffer.from("ffd8ffc0001108000a001400030111000211000311000000", "hex");
    expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 20, height: 10 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBPVP8X", 8, "ascii");
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(imageSize(webp, "image/webp")).toEqual({ width: 100, height: 50 });
    expect(numberLines(["a"], 7)).toBe("     7\ta");
  });
});
