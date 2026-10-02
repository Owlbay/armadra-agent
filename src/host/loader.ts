/**
 * `--host` 宿主适配器加载（设计 §6.2、§11.1 第 13 步）。[B5]
 *
 * - 路径相对 cwd 解析；`.cjs` 用 createRequire，`.mjs` 用动态 import，`.js` 先 require、
 *   遇到 ESM 再动态 import。模块导出可以是 `default`（ESM 默认导出 / CJS `module.exports`）
 *   或具名的 `hostApi` + `create`。
 * - 动态 import 的说明符是变量：bundle 是 CJS，esbuild 只改写字面量说明符的 `import()`，
 *   变量说明符原样保留，所以 bundle 里也能加载 ESM 适配器。
 * - 版本：`hostApi !== HOST_API_VERSION` → StartupError 78；加载失败 / 形状不对 → 6。
 * - `create(api)` 超时 10 s 或抛错 → 6；返回 undefined → 不激活。
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StartupError } from "../errors.js";
import type { HostAdapter, HostAdapterHandle, HostApi, HostModule } from "./types.js";
import { HOST_API_VERSION } from "./types.js";
import type { HostApiBinding } from "./api-impl.js";
import { msg } from "../i18n/index.js";

const EXIT_HOST = 6;
const EXIT_HOST_VERSION = 78;
export const HOST_CREATE_TIMEOUT_MS = 10_000;

/** 变量作说明符的 `import()`：esbuild 打 CJS 时原样保留（字面量说明符才会被改写成 require）。 */
function dynamicImport(specifier: string): Promise<unknown> {
  return import(specifier) as Promise<unknown>;
}

function loadFailure(message: string, cause?: unknown): StartupError {
  return new StartupError(
    "host_load_failed",
    message,
    EXIT_HOST,
    cause === undefined ? {} : { cause },
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function importModule(path: string): Promise<unknown> {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mjs")) return dynamicImport(pathToFileURL(path).href);
  const require = createRequire(pathToFileURL(path).href);
  if (lower.endsWith(".cjs")) return require(path) as unknown;
  try {
    return require(path) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ERR_REQUIRE_ESM" ||
      code === "ERR_REQUIRE_ASYNC_MODULE" ||
      error instanceof SyntaxError
    ) {
      return dynamicImport(pathToFileURL(path).href);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

/** 从模块命名空间 / exports 取出 HostModule 形状。 */
export function extractHostModule(namespace: unknown, label: string): HostModule {
  const candidates: unknown[] = [];
  if (isRecord(namespace)) {
    if (isRecord(namespace["default"])) {
      const inner = namespace["default"];
      // CJS 经 import 加载时 default 再套一层 default。
      if (isRecord(inner["default"]) && !("hostApi" in inner)) candidates.push(inner["default"]);
      candidates.push(inner);
    }
    candidates.push(namespace);
  }
  const found = candidates.find((c) => isRecord(c) && ("hostApi" in c || "create" in c));
  if (!isRecord(found)) throw loadFailure(msg().drivers.host.notAdapter(label));
  if (found["hostApi"] !== HOST_API_VERSION) {
    throw new StartupError(
      "host_version_mismatch",
      msg().drivers.host.versionMismatch(label, String(found["hostApi"]), HOST_API_VERSION),
      EXIT_HOST_VERSION,
    );
  }
  if (typeof found["create"] !== "function") throw loadFailure(msg().drivers.host.noCreate(label));
  return found as unknown as HostModule;
}

/** 加载并校验适配器模块。 */
export async function loadHostModule(spec: string, cwd = process.cwd()): Promise<HostModule> {
  const path = isAbsolute(spec) ? spec : resolve(cwd, spec);
  if (!existsSync(path)) throw loadFailure(msg().drivers.host.notFound(path));
  let namespace: unknown;
  try {
    namespace = await importModule(path);
  } catch (error) {
    throw loadFailure(msg().drivers.host.loadFailed(path, errorText(error)), error);
  }
  return extractHostModule(namespace, path);
}

/** 调 create(api)；返回 undefined 表示不激活。 */
export async function createAdapter(
  module: HostModule,
  api: HostApi,
  label: string,
  timeoutMs = HOST_CREATE_TIMEOUT_MS,
): Promise<HostAdapter | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(loadFailure(msg().drivers.host.createTimeout(label, timeoutMs))),
      timeoutMs,
    );
  });
  let adapter: HostAdapter | undefined;
  try {
    adapter = await Promise.race([Promise.resolve().then(() => module.create(api)), timeout]);
  } catch (error) {
    if (error instanceof StartupError) throw error;
    throw loadFailure(msg().drivers.host.createFailed(label, errorText(error)), error);
  } finally {
    clearTimeout(timer);
  }
  if (adapter === undefined || adapter === null) return undefined;
  if (typeof adapter !== "object" || typeof adapter.id !== "string" || adapter.id === "") {
    throw loadFailure(msg().drivers.host.noId(label));
  }
  return adapter;
}

export interface ActivateHostInput {
  /** 模块路径或已加载的 HostModule（SDK）。 */
  module: string | HostModule;
  binding: HostApiBinding;
  cwd?: string;
  timeoutMs?: number;
}

/** 第 13 步：加载 → 版本校验 → create；返回 handle 或 undefined（未激活）。 */
export async function activateHost(
  input: ActivateHostInput,
): Promise<HostAdapterHandle | undefined> {
  let module: HostModule;
  let source: string;
  if (typeof input.module === "string") {
    source = isAbsolute(input.module)
      ? input.module
      : resolve(input.cwd ?? process.cwd(), input.module);
    module = await loadHostModule(source);
  } else {
    source = "sdk";
    module = extractHostModule(input.module, "sdk");
  }
  const adapter = await createAdapter(module, input.binding.api, source, input.timeoutMs);
  return adapter === undefined ? undefined : input.binding.handle(adapter, source);
}

const disposed = new WeakSet<HostAdapterHandle>();

/** 调 dispose（幂等；异常交给 onError）。 */
export async function disposeHost(
  handle: HostAdapterHandle | undefined,
  onError: (error: unknown) => void = () => undefined,
): Promise<void> {
  if (handle === undefined) return;
  if (disposed.has(handle)) return;
  disposed.add(handle);
  try {
    await handle.adapter.dispose?.();
  } catch (error) {
    onError(error);
  }
}
