import { mkdtempSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MB } from "../ai/image-limits.js";
import { fitImage, loadImageFile } from "./image-file.js";
import { resizeImage, resizeTools, type RunCommand } from "./image-resize.js";
import { createReadTool } from "./read.js";
import type { ToolContext } from "./types.js";

/** 指定尺寸的 PNG 头 + 填充到 `bytes` 字节（只读文件头取尺寸，像素不必真实）。 */
function png(width: number, height: number, bytes = 64): Buffer {
  const head = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000000000000008060000001f15c489",
    "hex",
  );
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))]);
}

function jpeg(width: number, height: number, bytes = 64): Buffer {
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3]);
  sof.writeUInt16BE(height, 7);
  sof.writeUInt16BE(width, 9);
  return Buffer.concat([sof, Buffer.alloc(Math.max(0, bytes - sof.length))]);
}

interface Call {
  command: string;
  args: readonly string[];
}

/**
 * 假的命令执行器：`available` 里的工具存在；按参数里的边长写出一张 `edge × edge/2` 的图，
 * 体积 = edge² / `ratio` 字节。
 */
function fakeRun(available: readonly string[], ratio = 1): { run: RunCommand; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunCommand = async (command, args) => {
    calls.push({ command, args });
    if (!available.includes(command)) {
      return { code: null, stdout: Buffer.alloc(0), stderr: "", missing: true };
    }
    let edge: number;
    let output: string;
    if (command === "sips") {
      edge = Number(args[1]);
      output = args[args.length - 1] as string;
    } else {
      edge = Number(String(args[2]).split("x")[0]);
      output = args[3] as string;
    }
    const isJpeg = output.endsWith(".jpg");
    const bytes = Math.floor((edge * edge) / ratio);
    await writeFile(output, isJpeg ? jpeg(edge, edge / 2, bytes) : png(edge, edge / 2, bytes));
    return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
  };
  return { run, calls };
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "ama-resize-test-"));
}

describe("image-resize", () => {
  it("按平台的候选工具", () => {
    expect(resizeTools("darwin")).toEqual(["sips", "magick", "convert"]);
    expect(resizeTools("linux")).toEqual(["magick", "convert"]);
    expect(resizeTools("win32")).toEqual(["magick"]);
  });

  it("macOS 用 sips：参数形状、起始边长取 min(目标, 原长边)", async () => {
    const d = workdir();
    const input = join(d, "a.png");
    writeFileSync(input, png(3000, 1500));
    const { run, calls } = fakeRun(["sips"]);
    const out = await resizeImage(
      input,
      {
        maxEdge: 8000,
        maxBase64Bytes: 20 * MB,
        mimeType: "image/png",
        size: { width: 3000, height: 1500 },
      },
      { platform: "darwin", run, tmpDir: d },
    );
    expect(out).toMatchObject({ ok: true, tool: "sips", mimeType: "image/png" });
    expect(calls[0]?.args.slice(0, 5)).toEqual(["-Z", "3000", "-s", "format", "png"]);
  });

  it("体积仍超限就按 0.7 逐次缩小；JPEG 保持 JPEG", async () => {
    const d = workdir();
    const input = join(d, "a.jpg");
    writeFileSync(input, jpeg(4000, 2000));
    const { run, calls } = fakeRun(["magick"]);
    // 体积 = edge²；上限 2 MB（base64）→ 原始 1.5 MB → edge ≤ 1254
    const out = await resizeImage(
      input,
      {
        maxEdge: 8000,
        maxBase64Bytes: 2 * MB,
        mimeType: "image/jpeg",
        size: { width: 4000, height: 2000 },
      },
      { platform: "linux", run, tmpDir: d },
    );
    expect(out).toMatchObject({ ok: true, tool: "magick", mimeType: "image/jpeg" });
    expect(calls.map((c) => c.args[2])).toEqual([
      "4000x4000>",
      "2800x2800>",
      "1960x1960>",
      "1372x1372>",
      "960x960>",
    ]);
    expect(calls[0]?.args[0]).toBe(`${input}[0]`);
  });

  it("工具都不存在 → no_tool；工具在但缩不到 → failed；Windows 不试 convert", async () => {
    const d = workdir();
    const input = join(d, "a.png");
    writeFileSync(input, png(100, 100));
    const target = { maxEdge: 8000, maxBase64Bytes: 10, mimeType: "image/png" };
    const none = fakeRun([]);
    expect(
      await resizeImage(input, target, { platform: "linux", run: none.run, tmpDir: d }),
    ).toEqual({
      ok: false,
      reason: "no_tool",
    });
    expect(none.calls.map((c) => c.command)).toEqual(["magick", "convert"]);
    const win = fakeRun(["convert"]);
    expect(
      await resizeImage(input, target, { platform: "win32", run: win.run, tmpDir: d }),
    ).toEqual({
      ok: false,
      reason: "no_tool",
    });
    const big = fakeRun(["convert"]);
    expect(
      await resizeImage(input, target, { platform: "linux", run: big.run, tmpDir: d }),
    ).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("fitImage / loadImageFile / read：超限先缩放，没工具给提示，off 不缩", async () => {
    const d = workdir();
    const input = join(d, "shot.png");
    writeFileSync(input, png(3000, 2000, 6 * MB));
    const { run } = fakeRun(["sips"], 64);
    const deps = { platform: "darwin" as const, run, tmpDir: d };
    const fit = await fitImage(png(3000, 2000, 6 * MB), "image/png", { resizeDeps: deps }, input);
    expect(fit).toMatchObject({
      ok: true,
      resized: { tool: "sips", from: { width: 3000, height: 2000 } },
    });

    const loaded = await loadImageFile(input, { resizeDeps: deps });
    expect(loaded.bytes).toBeLessThan(6 * MB);

    const none = { platform: "linux" as const, run: fakeRun([]).run, tmpDir: d };
    await expect(loadImageFile(input, { resizeDeps: none })).rejects.toThrow(
      /no resize tool found/,
    );
    await expect(loadImageFile(input, { resize: "off", resizeDeps: deps })).rejects.toThrow(
      /images\.resize is off/,
    );

    const ctx = { cwd: d, markRead: () => undefined } as unknown as ToolContext;
    const read = createReadTool({ imageOptions: () => ({ resizeDeps: deps }) });
    const result = await read.execute({ path: "shot.png" }, ctx);
    expect(Array.isArray(result.content)).toBe(true);
    const caption = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(caption).toContain("Resized to 3000x1500");
    const readNone = createReadTool({ imageOptions: () => ({ resizeDeps: none }) });
    const rejected = await readNone.execute({ path: "shot.png" }, ctx);
    expect(rejected.content).toContain("no resize tool found");
  });
});
