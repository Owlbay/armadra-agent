/**
 * 剪贴板图片（docs/wave5-plan.md §4、D12）。[W5-I] 界面接线（`Ctrl+V`、`/paste`）归 W5-U。
 *
 * 零依赖读不了剪贴板位图，按平台依次调系统命令，成功写 `<dataDir>/clipboard/<时间戳>.png` 并返回
 * 路径（编辑器插入 `@<路径>`，之后走 loadImageFile）；没有工具或剪贴板里没有图返回 undefined：
 *
 * | 平台    | 依次尝试                                                                    |
 * | ------- | --------------------------------------------------------------------------- |
 * | macOS   | `osascript`（`the clipboard as «class PNGf»` 写文件）、`pngpaste <文件>`     |
 * | Linux   | Wayland（有 WAYLAND_DISPLAY）`wl-paste -t image/png`；`xclip -selection clipboard -t image/png -o` |
 * | Windows | `powershell` 的 `Get-Clipboard -Format Image` 存 PNG（路径经环境变量传入）  |
 *
 * 写出的文件必须以 PNG 文件头开头，否则删掉按「没有图」处理。`ama sessions prune` 清理超过 7 天的
 * 剪贴板文件（`gcClipboardImages`）。
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sniffImageMime } from "./image-file.js";
import { runCommand, type RunCommand } from "./image-resize.js";

export const CLIPBOARD_DIR = "clipboard";
export const CLIPBOARD_MAX_AGE_DAYS = 7;

export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  run?: RunCommand;
  env?: NodeJS.ProcessEnv;
  now?(): number;
}

export type ClipboardResult =
  | { ok: true; path: string; tool: string }
  /** `no_tool`：一个可用命令都没有；`no_image`：命令能用但剪贴板里没有图。 */
  | { ok: false; reason: "no_tool" | "no_image" };

const OSASCRIPT = [
  "on run argv",
  "try",
  "set png to the clipboard as «class PNGf»",
  "on error",
  'return "none"',
  "end try",
  "set f to open for access (POSIX file (item 1 of argv)) with write permission",
  "set eof f to 0",
  "write png to f",
  "close access f",
  'return "ok"',
  "end run",
];

const POWERSHELL =
  "$img = Get-Clipboard -Format Image; " +
  "if ($null -eq $img) { exit 3 }; " +
  "$img.Save($env:AMA_CLIPBOARD_OUT, [System.Drawing.Imaging.ImageFormat]::Png)";

type Attempt =
  | { tool: string; command: string; args: string[]; via: "file"; env?: NodeJS.ProcessEnv }
  | { tool: string; command: string; args: string[]; via: "stdout" };

function attempts(platform: NodeJS.Platform, file: string, env: NodeJS.ProcessEnv): Attempt[] {
  if (platform === "darwin") {
    return [
      {
        tool: "osascript",
        command: "osascript",
        args: [...OSASCRIPT.flatMap((line) => ["-e", line]), file],
        via: "file",
      },
      { tool: "pngpaste", command: "pngpaste", args: [file], via: "file" },
    ];
  }
  if (platform === "win32") {
    return [
      {
        tool: "powershell",
        command: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", POWERSHELL],
        via: "file",
        env: { ...env, AMA_CLIPBOARD_OUT: file },
      },
    ];
  }
  const list: Attempt[] = [];
  if (env["WAYLAND_DISPLAY"]) {
    list.push({ tool: "wl-paste", command: "wl-paste", args: ["-t", "image/png"], via: "stdout" });
  }
  list.push({
    tool: "xclip",
    command: "xclip",
    args: ["-selection", "clipboard", "-t", "image/png", "-o"],
    via: "stdout",
  });
  return list;
}

async function isPng(file: string): Promise<boolean> {
  try {
    return sniffImageMime(await readFile(file)) === "image/png";
  } catch {
    return false;
  }
}

/** 读剪贴板图片到数据目录；返回结果与原因（界面据此给一行提示）。 */
export async function readClipboardImage(
  dataDir: string,
  deps: ClipboardDeps = {},
): Promise<ClipboardResult> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? runCommand;
  const dir = join(dataDir, CLIPBOARD_DIR);
  await mkdir(dir, { recursive: true });
  const stamp = new Date((deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
  // 同一毫秒再贴：加序号，不能把上一张当成这次的结果
  let file = join(dir, `${stamp}.png`);
  for (let n = 1; existsSync(file); n++) file = join(dir, `${stamp}-${n}.png`);
  let anyTool = false;
  for (const attempt of attempts(platform, file, env)) {
    const options = attempt.via === "file" && attempt.env !== undefined ? { env: attempt.env } : {};
    const result = await run(attempt.command, attempt.args, options);
    if (result.missing === true) continue;
    anyTool = true;
    if (result.code !== 0) continue;
    if (attempt.via === "stdout") {
      if (sniffImageMime(result.stdout) !== "image/png") continue;
      await writeFile(file, result.stdout);
    }
    if (await isPng(file)) return { ok: true, path: file, tool: attempt.tool };
    await rm(file, { force: true });
  }
  await rm(file, { force: true });
  return { ok: false, reason: anyTool ? "no_image" : "no_tool" };
}

/** §10.2 的签名：成功返回 PNG 路径，没有工具或没有图返回 undefined。 */
export async function pasteClipboardImage(
  dataDir: string,
  deps: ClipboardDeps = {},
): Promise<string | undefined> {
  const result = await readClipboardImage(dataDir, deps);
  return result.ok ? result.path : undefined;
}

/** 清理 `<dataDir>/clipboard/` 里超过 `maxAgeDays`（缺省 7）天的文件；返回（将）删除的路径。 */
export async function gcClipboardImages(
  dataDir: string,
  options: { dryRun?: boolean; maxAgeDays?: number; now?: number } = {},
): Promise<string[]> {
  const dir = join(dataDir, CLIPBOARD_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const cutoff =
    (options.now ?? Date.now()) - (options.maxAgeDays ?? CLIPBOARD_MAX_AGE_DAYS) * 86_400_000;
  const removed: string[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
      if (options.dryRun !== true) await rm(file, { force: true });
      removed.push(file);
    } catch {
      // 并发删除等：跳过
    }
  }
  return removed;
}
