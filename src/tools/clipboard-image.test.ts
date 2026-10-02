import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gcClipboardImages,
  pasteClipboardImage,
  readClipboardImage,
  type ClipboardDeps,
} from "./clipboard-image.js";
import type { CommandResult, RunCommand } from "./image-resize.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f9d0000000049454e44ae426082",
  "hex",
);

interface Call {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv | undefined;
}

type Behavior = "missing" | "fail" | "empty" | "png" | "text";

/** 每个命令的行为：写文件型（osascript / pngpaste / powershell）往目标文件写，stdout 型返回内容。 */
function fake(behaviors: Record<string, Behavior>): { run: RunCommand; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunCommand = async (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    const behavior = behaviors[command] ?? "missing";
    const ok = (stdout = Buffer.alloc(0)): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (behavior === "missing")
      return { code: null, stdout: Buffer.alloc(0), stderr: "", missing: true };
    if (behavior === "fail") return { code: 1, stdout: Buffer.alloc(0), stderr: "no image" };
    const target =
      command === "powershell"
        ? options?.env?.["AMA_CLIPBOARD_OUT"]
        : (args[args.length - 1] as string);
    const toFile = command === "osascript" || command === "pngpaste" || command === "powershell";
    if (behavior === "empty") return ok();
    const content = behavior === "png" ? PNG : Buffer.from("hello");
    if (toFile) {
      await writeFile(target as string, content);
      return ok();
    }
    return ok(content);
  };
  return { run, calls };
}

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "ama-clip-"));
}

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

function deps(
  platform: NodeJS.Platform,
  run: RunCommand,
  env: NodeJS.ProcessEnv = {},
): ClipboardDeps {
  return { platform, run, env, now: () => NOW };
}

describe("clipboard-image", () => {
  it("macOS：osascript 成功 → <dataDir>/clipboard/<时间戳>.png，路径作为参数传入", async () => {
    const d = dataDir();
    const { run, calls } = fake({ osascript: "png" });
    const result = await readClipboardImage(d, deps("darwin", run));
    expect(result).toEqual({
      ok: true,
      tool: "osascript",
      path: join(d, "clipboard", "2026-10-02T12-00-00-000Z.png"),
    });
    expect(calls[0]?.args.at(-1)).toBe(join(d, "clipboard", "2026-10-02T12-00-00-000Z.png"));
    expect(calls[0]?.args).toContain("set png to the clipboard as «class PNGf»");
  });

  it("macOS：osascript 无图（不写文件）→ 试 pngpaste；都没图 → no_image", async () => {
    const d = dataDir();
    const a = fake({ osascript: "empty", pngpaste: "png" });
    expect(await readClipboardImage(d, deps("darwin", a.run))).toMatchObject({
      ok: true,
      tool: "pngpaste",
    });
    const b = fake({ osascript: "empty", pngpaste: "fail" });
    expect(await readClipboardImage(d, deps("darwin", b.run))).toEqual({
      ok: false,
      reason: "no_image",
    });
    expect(b.calls.map((c) => c.command)).toEqual(["osascript", "pngpaste"]);
  });

  it("Linux Wayland：wl-paste 的 stdout 写成文件；不是 PNG 则退到 xclip", async () => {
    const d = dataDir();
    const a = fake({ "wl-paste": "png" });
    const ok = await readClipboardImage(d, deps("linux", a.run, { WAYLAND_DISPLAY: "wayland-0" }));
    expect(ok).toMatchObject({ ok: true, tool: "wl-paste" });
    expect(a.calls[0]?.args).toEqual(["-t", "image/png"]);
    const b = fake({ "wl-paste": "text", xclip: "png" });
    expect(
      await readClipboardImage(d, deps("linux", b.run, { WAYLAND_DISPLAY: "wayland-0" })),
    ).toMatchObject({ ok: true, tool: "xclip" });
  });

  it("Linux X11：不试 wl-paste，xclip 参数；都没装 → no_tool 且不留文件", async () => {
    const d = dataDir();
    const a = fake({ xclip: "png" });
    expect(await readClipboardImage(d, deps("linux", a.run))).toMatchObject({
      ok: true,
      tool: "xclip",
    });
    expect(a.calls.map((c) => [c.command, ...c.args])).toEqual([
      ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
    ]);
    const none = fake({});
    const d2 = dataDir();
    expect(await readClipboardImage(d2, deps("linux", none.run))).toEqual({
      ok: false,
      reason: "no_tool",
    });
    expect(readdirSync(join(d2, "clipboard"))).toEqual([]);
  });

  it("Windows：PowerShell，输出路径经环境变量；非 PNG 内容删掉按无图", async () => {
    const d = dataDir();
    const a = fake({ powershell: "png" });
    const result = await readClipboardImage(d, deps("win32", a.run, { PATH: "x" }));
    expect(result).toMatchObject({ ok: true, tool: "powershell" });
    expect(a.calls[0]?.args.slice(0, 4)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
    ]);
    expect(a.calls[0]?.args[4]).toContain("Get-Clipboard -Format Image");
    expect(a.calls[0]?.env).toMatchObject({
      PATH: "x",
      AMA_CLIPBOARD_OUT: result.ok ? result.path : "",
    });
    const b = fake({ powershell: "text" });
    const d2 = dataDir();
    expect(await readClipboardImage(d2, deps("win32", b.run))).toEqual({
      ok: false,
      reason: "no_image",
    });
    expect(readdirSync(join(d2, "clipboard"))).toEqual([]);
  });

  it("pasteClipboardImage：成功给路径，失败 undefined", async () => {
    const d = dataDir();
    const path = await pasteClipboardImage(d, deps("darwin", fake({ osascript: "png" }).run));
    expect(path !== undefined && existsSync(path)).toBe(true);
    expect(await pasteClipboardImage(d, deps("darwin", fake({}).run))).toBeUndefined();
  });

  it("gcClipboardImages：只清超过 7 天的文件，dryRun 不删", async () => {
    const d = dataDir();
    expect(await gcClipboardImages(d)).toEqual([]);
    const dir = join(d, "clipboard");
    mkdirSync(dir);
    const old = join(dir, "old.png");
    const fresh = join(dir, "fresh.png");
    writeFileSync(old, PNG);
    writeFileSync(fresh, PNG);
    const eightDaysAgo = (NOW - 8 * 86_400_000) / 1000;
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    utimesSync(fresh, NOW / 1000, NOW / 1000);
    expect(await gcClipboardImages(d, { now: NOW, dryRun: true })).toEqual([old]);
    expect(existsSync(old)).toBe(true);
    expect(await gcClipboardImages(d, { now: NOW })).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
