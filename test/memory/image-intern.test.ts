/**
 * [M-D] 图片按内容驻留（docs/memory-plan.md D5、§2.5）：`read` 反复读同一张图、附图与读图、恢复会话里
 * 重复出现的图，都只留一份 base64；会话文件字节、fork / getEntries 不受影响。
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ContentBlock, ImageBlock } from "../../src/ai/types.js";
import { SessionManager } from "../../src/session/manager.js";
import { loadImageFile } from "../../src/tools/image-file.js";
import { executeRead } from "../../src/tools/read.js";
import { measureGrowth } from "../helpers/memory.js";
import { makeToolContext } from "../helpers/tool-context.js";

const KB = 1024;
const dir = mkdtempSync(join(tmpdir(), "ama-mem-image-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 1×2 的 PNG 后面接 `padding` 字节随机数据：嗅探与尺寸都按 PNG 头走，内容每次不同。 */
function writePng(name: string, padding: number): string {
  const head = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000208060000009977a8a40000000d4944415478da63f8ffff3f0005fe02fea7d6a9f30000000049454e44ae426082",
    "hex",
  );
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([head, randomBytes(padding)]));
  return path;
}

async function readImageBlock(path: string): Promise<ImageBlock> {
  const result = await executeRead({ path }, makeToolContext(dir));
  const block = (result.content as ContentBlock[]).find((b) => b.type === "image");
  if (block?.type !== "image") throw new Error("read did not return an image");
  return block;
}

describe("[M-D] 图片驻留", () => {
  it("同一 PNG 经 read 读 5 次：5 个 block 是同一对象；第 2–5 次合计增长 < 200 KB", async () => {
    const path = writePng("same.png", 1024 * KB);
    const first = await readImageBlock(path);
    expect(first.data.length).toBeGreaterThan(1300 * KB);
    const growth = await measureGrowth(async () => {
      const blocks: ImageBlock[] = [];
      for (let i = 0; i < 4; i++) blocks.push(await readImageBlock(path));
      return blocks;
    });
    for (const block of growth.result) expect(block).toBe(first);
    expect(growth.total).toBeLessThan(200 * KB);
  });

  it("附图（loadImageFile）与 read 读同一文件：同一个 block", async () => {
    const path = writePng("attach.png", 64 * KB);
    const attached = await loadImageFile(path);
    expect(await readImageBlock(path)).toBe(attached.block);
  });

  it("会话里同一图片出现 4 次：open 后 4 处同一 block；文件字节、getEntries、fork 不变", () => {
    const data = randomBytes(256 * KB).toString("base64");
    const sessions = join(dir, "sessions");
    const writer = SessionManager.create(sessions, dir, {
      now: () => new Date(Date.UTC(2026, 9, 1)),
    });
    for (let i = 0; i < 4; i++) {
      // 每次新拼字符串：落盘前就各是一份
      const copy = `${data.slice(0, 8)}${data.slice(8)}`;
      writer.append({
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: `看图 ${i}` },
            { type: "image", data: copy, mimeType: "image/png" },
          ],
          timestamp: Date.UTC(2026, 9, 1) + i,
        },
      });
    }
    const file = writer.flush()!;
    const expectedEntries = structuredClone(writer.getEntries());
    writer.close();
    const bytes = readFileSync(file);

    const reader = SessionManager.open(file);
    try {
      const images = reader
        .entries()
        .flatMap((entry): readonly unknown[] =>
          entry.type === "message" &&
          Array.isArray((entry.message as { content?: unknown }).content)
            ? (entry.message as { content: unknown[] }).content
            : [],
        )
        .filter((block): block is ImageBlock => (block as ImageBlock | null)?.type === "image");
      expect(images).toHaveLength(4);
      for (const image of images) expect(image).toBe(images[0]);
      expect(reader.getEntries()).toEqual(expectedEntries);

      const last = reader.leafId()!;
      const forked = reader.fork(last);
      try {
        expect(
          forked.getEntries().entries.map((e) => (e.type === "message" ? e.message : e)),
        ).toEqual(expectedEntries.entries.map((e) => (e.type === "message" ? e.message : e)));
      } finally {
        forked.close();
      }
    } finally {
      reader.close();
    }
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });
});
