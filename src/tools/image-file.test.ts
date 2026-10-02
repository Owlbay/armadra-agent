import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../ai/providers/registry.js";
import { modelAcceptsImages } from "../cli/compose.js";
import { emptyComposeState } from "../cli/compose-session.js";
import { MAX_IMAGE_BYTES, imageMimeFromPath, loadImageFile, sniffImageMime } from "./image-file.js";
import { createReadTool } from "./read.js";
import type { ToolContext } from "./types.js";

/** 1×1 PNG。 */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f9d0000000049454e44ae426082",
  "hex",
);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ama-img-"));
}

describe("image-file", () => {
  it("按文件头识别；认不出退回扩展名", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG_HEAD)).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a......"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("hello"))).toBeUndefined();
    expect(imageMimeFromPath("/x/A.JPG")).toBe("image/jpeg");
    expect(imageMimeFromPath("/x/a.txt")).toBeUndefined();
  });

  it("loadImageFile：成功给 ImageBlock 与尺寸；扩展名不符以文件头为准", async () => {
    const d = dir();
    writeFileSync(join(d, "a.png"), PNG);
    const loaded = await loadImageFile(join(d, "a.png"));
    expect(loaded).toMatchObject({
      mimeType: "image/png",
      bytes: PNG.length,
      size: { width: 1, height: 1 },
    });
    expect(loaded.block).toEqual({
      type: "image",
      mimeType: "image/png",
      data: PNG.toString("base64"),
    });
    writeFileSync(join(d, "fake.png"), JPEG_HEAD);
    expect((await loadImageFile(join(d, "fake.png"))).mimeType).toBe("image/jpeg");
  });

  it("loadImageFile：不存在、不是图片、超过上限 → 清楚的错误", async () => {
    const d = dir();
    await expect(loadImageFile(join(d, "none.png"))).rejects.toThrow(/图片不存在/);
    writeFileSync(join(d, "notes.bin"), "hello");
    await expect(loadImageFile(join(d, "notes.bin"))).rejects.toThrow(/不是支持的图片/);
    writeFileSync(join(d, "big.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    await expect(loadImageFile(join(d, "big.png"))).rejects.toThrow(/超过 5 MB/);
  });

  it("read 工具：超过上限只给说明不附图", async () => {
    const d = dir();
    writeFileSync(join(d, "big.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    const ctx = { cwd: d, markRead: () => undefined } as unknown as ToolContext;
    const result = await createReadTool().execute({ path: "big.png" }, ctx);
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("attachment limit");
  });

  it("modelAcceptsImages：按注册表里当前模型的 input 判断", () => {
    const state = emptyComposeState();
    expect(modelAcceptsImages(state, { provider: "relay", id: "vl" })).toBe(true);
    state.providers = new ProviderRegistry({
      includeFake: false,
      keys: { env: {}, userAuthFile: null },
      config: {
        version: 1,
        providers: {
          relay: {
            baseUrl: "https://relay.example/v1",
            models: [{ id: "vl", input: ["text", "image"] }, { id: "txt" }],
          },
        },
      },
    });
    expect(modelAcceptsImages(state, { provider: "relay", id: "vl" })).toBe(true);
    expect(modelAcceptsImages(state, { provider: "relay", id: "txt" })).toBe(false);
  });
});
