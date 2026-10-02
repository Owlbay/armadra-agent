/**
 * `--from <会话 id>[#编号]`：用旧会话里的一条用户消息作为新提示（docs/sessions.md「复用」）。[W4-D]
 *
 * - 文本：那条消息的文本；命令行另有位置参数时接在后面（空一行）；
 * - 图片：`-p` 时把图片块写进临时目录、追加到 `--image`（沿用 print 模式的图片校验：模型不收图片 →
 *   用法错误），运行结束删掉；交互 / 行式界面只带文本，有图片时在 stderr 提示一行；
 * - 交互模式经现有的「初始提示」参数传入（启动后直接提交，与 `ama "提示"` 相同）；
 * - `--mode rpc` 不支持（rpc 的提示来自宿主）。
 * 会话目录用 bootstrap 解析后的 `paths.sessionDir`（含 `--session-dir` 与 profile），本目录优先找 id。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFromMessage } from "../session/reuse.js";
import { UsageError, type ParsedArgs } from "./args.js";
import type { CliIo, ModeContext } from "./deps.js";
import type { Runtime } from "./runtime.js";
import { msg } from "../i18n/index.js";

const EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface FromContext {
  context: ModeContext;
  cleanup(): void;
}

export function applyFromOption(
  args: ParsedArgs,
  runtime: Pick<Runtime, "mode" | "paths">,
  io: CliIo,
): FromContext {
  const spec = args.from;
  const plain: FromContext = { context: { args, prompt: args.prompt, io }, cleanup: () => {} };
  if (spec === undefined) return plain;
  if (runtime.mode === "rpc") throw new UsageError(msg().cli.fromPrompt.notWithRpc);
  const picked = resolveFromMessage(runtime.paths.sessionDir, spec, runtime.paths.cwd);
  const parts = [picked.text, args.prompt ?? ""].filter((p) => p.trim() !== "");
  const prompt = parts.length > 0 ? parts.join("\n\n") : undefined;
  if (picked.images.length === 0) {
    return { context: { args, prompt, io }, cleanup: () => {} };
  }
  if (runtime.mode !== "print") {
    io.stderr(msg().cli.fromPrompt.imagesDropped(picked.images.length));
    return { context: { args, prompt, io }, cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "ama-from-"));
  const files = picked.images.map((image, i) => {
    const file = join(dir, `${picked.n}-${i + 1}.${EXT[image.mimeType] ?? "png"}`);
    writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return file;
  });
  return {
    context: { args: { ...args, images: [...args.images, ...files] }, prompt, io },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
