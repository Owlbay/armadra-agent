/**
 * 可选的图片缩放（docs/wave5-plan.md §4、D12）。[W5-I]
 *
 * 零依赖不能解码像素，只能调系统工具：macOS 依次试 `sips`、`magick`、`convert`；Linux 试
 * `magick`、`convert`；Windows 只试 `magick`（`convert.exe` 是系统的磁盘转换工具）。都没有就返回
 * `no_tool`，调用方按原规则拒绝并提示。只在超限时调用（`images.resize: "auto"`，缺省）。
 *
 * 输出写临时目录，读回后删掉；JPEG 保持 JPEG，其余格式输出 PNG（GIF 取第一帧）。边长先取
 * min(目标边长, 原长边)，体积仍超限就按 0.7 逐次缩小，最多 5 次。
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64Size } from "../ai/image-limits.js";
import { imageSize, type ImageSize } from "./image-file.js";

export interface CommandResult {
  /** 进程退出码；命令不存在 / 无法启动为 null。 */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** 命令不存在（ENOENT）。 */
  missing?: boolean;
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

/** 缺省的命令执行器：execFile，stdout 按 Buffer 收，30 s 超时。 */
export const runCommand: RunCommand = (command, args, options = {}) =>
  new Promise((resolvePromise) => {
    execFile(
      command,
      [...args],
      {
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
        windowsHide: true,
        ...(options.env !== undefined ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
        const missing = err !== null && err.code === "ENOENT";
        const code =
          err === null ? 0 : typeof err.code === "number" ? err.code : missing ? null : 1;
        resolvePromise({
          code,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
          ...(missing ? { missing: true } : {}),
        });
      },
    );
  });

export interface ResizeTarget {
  /** 长边上限（像素）。 */
  maxEdge: number;
  /** base64 后的体积上限（字节）。 */
  maxBase64Bytes: number;
  mimeType: string;
  /** 原图尺寸（已知时用来定起始边长）。 */
  size?: ImageSize | undefined;
}

export interface ResizeDeps {
  platform?: NodeJS.Platform;
  run?: RunCommand;
  /** 临时目录的父目录；缺省 os.tmpdir()。 */
  tmpDir?: string;
}

export interface ResizedImage {
  ok: true;
  buf: Buffer;
  mimeType: string;
  size?: ImageSize;
  /** 用到的工具（`sips` / `magick` / `convert`）。 */
  tool: string;
}

export interface ResizeFailure {
  ok: false;
  reason: "no_tool" | "failed";
}

const MAX_ATTEMPTS = 5;
const SHRINK = 0.7;
const MIN_EDGE = 64;

/** 按平台的候选工具，靠前的先试。 */
export function resizeTools(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["sips", "magick", "convert"];
  if (platform === "win32") return ["magick"];
  return ["magick", "convert"];
}

function resizeArgs(
  tool: string,
  input: string,
  output: string,
  edge: number,
  format: "png" | "jpeg",
): string[] {
  if (tool === "sips") return ["-Z", String(edge), "-s", "format", format, input, "--out", output];
  // ImageMagick：`[0]` 取第一帧，`>` 只缩小不放大
  return [`${input}[0]`, "-resize", `${edge}x${edge}>`, output];
}

/**
 * 把 `input` 缩到目标以内。`no_tool`：一个可用工具都没有；`failed`：工具能用但缩不到目标。
 */
export async function resizeImage(
  input: string,
  target: ResizeTarget,
  deps: ResizeDeps = {},
): Promise<ResizedImage | ResizeFailure> {
  const run = deps.run ?? runCommand;
  const format = target.mimeType === "image/jpeg" ? "jpeg" : "png";
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  const long = target.size !== undefined ? Math.max(target.size.width, target.size.height) : 0;
  const start = long > 0 ? Math.min(target.maxEdge, long) : target.maxEdge;
  const dir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "ama-resize-"));
  try {
    for (const tool of resizeTools(deps.platform ?? process.platform)) {
      let edge = start;
      let worked = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && edge >= MIN_EDGE; attempt++) {
        const output = join(dir, `out-${attempt}.${format === "jpeg" ? "jpg" : "png"}`);
        const result = await run(tool, resizeArgs(tool, input, output, edge, format));
        if (result.missing === true || result.code !== 0) break;
        let buf: Buffer;
        try {
          buf = await readFile(output);
        } catch {
          break;
        }
        worked = true;
        const size = imageSize(buf, mimeType);
        const longOut = size !== undefined ? Math.max(size.width, size.height) : 0;
        if (base64Size(buf.length) <= target.maxBase64Bytes && longOut <= target.maxEdge) {
          return { ok: true, buf, mimeType, tool, ...(size !== undefined ? { size } : {}) };
        }
        edge = Math.round(Math.min(edge, longOut > 0 ? longOut : edge) * SHRINK);
      }
      // 工具能用但缩不到目标：换工具也不会更好
      if (worked) return { ok: false, reason: "failed" };
    }
    return { ok: false, reason: "no_tool" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
