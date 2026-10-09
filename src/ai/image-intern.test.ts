import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gcUntil } from "../../test/helpers/memory.js";
import { internedImageCount, internImage, internSessionImages, sha256Hex } from "./image-intern.js";
import type { ImageBlock } from "./types.js";

const image = (data: string, mimeType = "image/png"): ImageBlock => ({
  type: "image",
  data,
  mimeType,
});
const fresh = (bytes = 64): string => randomBytes(bytes).toString("base64");

describe("internImage", () => {
  it("同内容返回首个登记的 block；内容或 mimeType 不同不合并", () => {
    const data = fresh();
    const first = image(data);
    expect(internImage(first)).toBe(first);
    // 新拼出来的同值字符串：命中后拿到的是第一个 block（字符串随之共享）
    const again = image(data.slice(0, 10) + data.slice(10));
    expect(internImage(again)).toBe(first);
    const other = image(fresh());
    expect(internImage(other)).toBe(other);
    const jpeg = image(data, "image/jpeg");
    expect(internImage(jpeg)).toBe(jpeg);
  });

  it("调用方给的 hash 与现算的一致时同样命中", () => {
    const data = fresh();
    const first = internImage(image(data), sha256Hex(data));
    expect(internImage(image(data))).toBe(first);
    expect(internImage(image(data), sha256Hex(Buffer.from(data)))).toBe(first);
  });

  it("所有引用释放后 WeakRef 失效，FinalizationRegistry 清掉键", async () => {
    const before = internedImageCount();
    let held: ImageBlock[] | undefined = [
      internImage(image(fresh(1024))),
      internImage(image(fresh(1024))),
    ];
    const refs = held.map((block) => new WeakRef(block));
    expect(internedImageCount()).toBe(before + 2);
    held = undefined;
    expect(await gcUntil(() => refs.every((ref) => ref.deref() === undefined))).toBe(true);
    // 前面用例登记的 block 也都没人引用了：表回到 0
    expect(await gcUntil(() => internedImageCount() === 0)).toBe(true);
  });

  it("键被新 block 重新占用后，旧 block 的清理回调不删新键", async () => {
    const data = fresh(1024);
    let old: ImageBlock | undefined = internImage(image(data));
    const ref = new WeakRef(old);
    old = undefined;
    expect(await gcUntil(() => ref.deref() === undefined)).toBe(true);
    const replacement = internImage(image(data));
    await gcUntil(() => false, 3); // 让旧 block 的清理回调跑完
    expect(internImage(image(data))).toBe(replacement);
  });
});

describe("internSessionImages", () => {
  it("只替换 message 条目 content 数组里的 image 块，返回替换数；条目其余部分不动", () => {
    const data = fresh();
    const entries = [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "a" }, image(data)] },
      },
      { type: "message", message: { role: "toolResult", content: [image(data)] } },
      { type: "message", message: { role: "user", content: "plain" } },
      { type: "custom", message: { content: [image(data)] } },
      { type: "message", message: { role: "user", content: [image(data), null] } },
    ];
    const custom = entries[3]!.message.content as ImageBlock[];
    const customBlock = custom[0];
    expect(internSessionImages(entries)).toBe(2);
    const blocks = [entries[0]!, entries[1]!, entries[4]!].map((entry) =>
      (entry.message.content as unknown[]).find((b) => (b as ImageBlock)?.type === "image"),
    );
    expect(blocks[1]).toBe(blocks[0]);
    expect(blocks[2]).toBe(blocks[0]);
    expect(custom[0]).toBe(customBlock);
    expect(entries[0]!.message.content).toHaveLength(2);
    expect(internSessionImages([])).toBe(0);
  });
});
