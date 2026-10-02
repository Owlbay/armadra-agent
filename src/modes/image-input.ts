/**
 * 用户侧的图片输入（docs/providers.md「图像输入」）：`ama -p --image`、交互 / 行式界面里的 `@图片路径`
 * 与粘贴 / 拖入的图片文件路径。
 *
 * - `--image` 与 `@路径` 是显式附件：文件不存在、不是图片、超过上限，或当前模型 `input` 不含 image
 *   → 报错，不发请求；
 * - 不带 `@` 的词只在「以图片扩展名结尾且文件存在」时才算附件，当前模型不收图片时静默忽略（用户可能
 *   只是在文字里提到一个文件）；
 * - 与 read 工具共用 image-file.ts 的 MIME 检测与单图上限（[W5-I] 按当前模型的端点分档，base64 后
 *   计算，见 ai/image-limits.ts）。提示文字原样保留。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentSession } from "../agent/types.js";
import { formatModelRef } from "../ai/providers/channels.js";
import type { ImageBlock, Model, ModelRef, ProviderRegistryApi } from "../ai/types.js";
import type { ImagesConfig } from "../config/types-w5.js";
import { AmaError } from "../errors.js";
import { imageLimits } from "../ai/image-limits.js";
import { imageMimeFromPath, loadImageFile, type ImageFitOptions } from "../tools/image-file.js";

export interface ImageRef {
  path: string;
  /** `@路径` 或 `--image`：显式附件。 */
  explicit: boolean;
}

const TOKEN = /@?"([^"]+)"|@?'([^']+)'|((?:\\ |\S)+)/g;

function expand(path: string, cwd: string): string {
  const home = path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
  return resolve(cwd, home);
}

/** 从提示里找图片引用：`@路径`（可加引号）与以图片扩展名结尾、文件存在的词（拖入的路径常带 `\ `）。 */
export function findImageRefs(text: string, cwd: string): ImageRef[] {
  const out: ImageRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    let token = m[1] ?? m[2] ?? m[3] ?? "";
    const explicit = m[0].startsWith("@");
    if (m[3] !== undefined && explicit) token = token.slice(1);
    token = token.replace(/\\ /g, " ").replace(/[,，。;；)）]+$/, "");
    if (token === "" || imageMimeFromPath(token) === undefined) continue;
    const path = expand(token, cwd);
    if (!explicit && !existsSync(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, explicit });
  }
  return out;
}

/** 当前会话的模型（查不到返回 undefined）。 */
export function sessionModel(
  providers: ProviderRegistryApi,
  session: AgentSession,
): Model | undefined {
  const ref = session.state.model;
  if (ref === undefined) return undefined;
  const found = providers.findModel(formatModelRef(ref));
  return found.ok ? found.model : undefined;
}

/**
 * 读出附件：显式附件遇到模型不收图片 → AmaError（提示换模型）；隐式附件此时忽略。
 */
export async function loadPromptImages(
  refs: readonly ImageRef[],
  model: Model | undefined,
  options: ImageFitOptions = {},
): Promise<ImageBlock[]> {
  const accepts = model === undefined || model.input.includes("image");
  const wanted = refs.filter((ref) => ref.explicit || accepts);
  if (wanted.length === 0) return [];
  if (!accepts) {
    const name = model === undefined ? "当前模型" : `${model.provider}/${model.id}`;
    throw new AmaError(
      "invalid_arguments",
      `${name} 不接受图片输入（模型 input 没有 image）；换一个支持图像的模型再试` +
        `（ama models list 里标「图片」的，或在配置里给该模型写 "input": ["text", "image"]）`,
    );
  }
  const fit: ImageFitOptions = {
    ...(model !== undefined ? { maxBase64Bytes: imageLimits(model).perImageBase64 } : {}),
    ...options,
  };
  const blocks: ImageBlock[] = [];
  for (const ref of wanted) blocks.push((await loadImageFile(ref.path, fit)).block);
  return blocks;
}

/** 提示 + 额外的显式图片路径（`--image`）→ 附件。 */
export async function promptImages(
  text: string,
  extra: readonly string[],
  cwd: string,
  model: Model | undefined,
  options: ImageFitOptions = {},
): Promise<ImageBlock[]> {
  const refs = [
    ...extra.map((path) => ({ path: expand(path, cwd), explicit: true })),
    ...findImageRefs(text, cwd),
  ];
  const unique = refs.filter((ref, i) => refs.findIndex((r) => r.path === ref.path) === i);
  return loadPromptImages(unique, model, options);
}

/**
 * read 工具的单图选项（compose.ts 接线）：按会话当前模型的端点分档（查不到模型时用缺省 5 MB），
 * 缩放按 `images.resize`。
 */
export function imageFitOptionsFor(
  providers: ProviderRegistryApi | undefined,
  ref: ModelRef | undefined,
  images?: ImagesConfig,
): ImageFitOptions {
  const resize = images?.resize !== undefined ? { resize: images.resize } : {};
  if (providers === undefined || ref === undefined) return resize;
  const found = providers.findModel(formatModelRef(ref));
  return found.ok ? { maxBase64Bytes: imageLimits(found.model).perImageBase64, ...resize } : resize;
}
