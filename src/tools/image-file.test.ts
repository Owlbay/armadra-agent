import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../ai/providers/registry.js";
import { modelAcceptsImages } from "../cli/compose.js";
import { emptyComposeState } from "../cli/compose-session.js";
import { DEFAULT_IMAGE_BASE64_LIMIT, MB } from "../ai/image-limits.js";
import { fitImage, imageMimeFromPath, loadImageFile, sniffImageMime } from "./image-file.js";
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

  it("loadImageFile：不存在、不是图片、超过上限 → 清楚的错误（英文 message + 结构化 detail，界面层本地化）", async () => {
    const d = dir();
    await expect(loadImageFile(join(d, "none.png"))).rejects.toMatchObject({
      message: expect.stringMatching(/Image not found/),
      detail: { reason: "missing", path: join(d, "none.png") },
    });
    writeFileSync(join(d, "notes.bin"), "hello");
    await expect(loadImageFile(join(d, "notes.bin"))).rejects.toMatchObject({
      message: expect.stringMatching(/Unsupported image/),
      detail: { reason: "unsupported" },
    });
    // 原始 4 MB → base64 后约 5.3 MB：按 base64 计超过缺省 5 MB
    writeFileSync(join(d, "big.png"), Buffer.concat([PNG, Buffer.alloc(4 * MB)]));
    await expect(loadImageFile(join(d, "big.png"), { resize: "off" })).rejects.toMatchObject({
      message: expect.stringMatching(/exceeds the 5 MB limit \(base64\).*images\.resize is off/),
      detail: { reason: "too_large", limitMb: "5 MB", hint: "resize_off" },
    });
    // 官方 Anthropic 的 10 MB 档放行
    await expect(
      loadImageFile(join(d, "big.png"), { maxBase64Bytes: 10 * MB }),
    ).resolves.toMatchObject({ mimeType: "image/png" });
  });

  it("fitImage：base64 边界与 8000 px 边长", async () => {
    // 3 字节 → 4 字节 base64：恰好等于上限放行，多一组拒绝
    const head = PNG.subarray(0, 24);
    const limit = Math.ceil(head.length / 3) * 4;
    expect((await fitImage(head, "image/png", { maxBase64Bytes: limit })).ok).toBe(true);
    expect((await fitImage(head, "image/png", { maxBase64Bytes: limit - 1 })).ok).toBe(false);
    const wide = Buffer.from(PNG);
    wide.writeUInt32BE(8001, 16);
    const fit = await fitImage(wide, "image/png");
    expect(fit).toMatchObject({ ok: false, reason: "too_wide" });
    expect(DEFAULT_IMAGE_BASE64_LIMIT).toBe(5 * MB);
  });

  it("read 工具：超过上限只给说明不附图", async () => {
    const d = dir();
    writeFileSync(join(d, "big.png"), Buffer.concat([PNG, Buffer.alloc(5 * MB)]));
    const ctx = { cwd: d, markRead: () => undefined } as unknown as ToolContext;
    const off = createReadTool({ imageOptions: () => ({ resize: "off" }) });
    const result = await off.execute({ path: "big.png" }, ctx);
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("attachment limit");
    const wide = Buffer.from(PNG);
    wide.writeUInt32BE(9000, 20);
    writeFileSync(join(d, "tall.png"), wide);
    const tall = await off.execute({ path: "tall.png" }, ctx);
    expect(tall.content).toContain("larger than 8000px");
    // 按模型分档：给 10 MB 时 4 MB 原图（≈5.3 MB base64）可附
    writeFileSync(join(d, "mid.png"), Buffer.concat([PNG, Buffer.alloc(4 * MB)]));
    const tiered = createReadTool({ imageOptions: () => ({ maxBase64Bytes: 10 * MB }) });
    const mid = await tiered.execute({ path: "mid.png" }, ctx);
    expect(Array.isArray(mid.content)).toBe(true);
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
