/**
 * 环境变量代理（W4-C）：Node 的全局 fetch 缺省不读 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`。
 *
 * - 没设代理变量 → 什么都不做。
 * - 运行时已接管（`NODE_USE_ENV_PROXY=1` 或 `--use-env-proxy`，且 Node 支持）→ 不重复设置。
 * - Node 有 `http.setGlobalProxyFromEnv()`（24.x / 26.x 等）→ 进程启动时调用一次，等价于
 *   `NODE_USE_ENV_PROXY=1`（fetch 与 http/https 全局 agent 都走代理，`NO_PROXY` 生效）。零依赖。
 * - 不支持的 Node 版本 → 只在会联网的命令里于 stderr 提示一次（不中断）。
 *
 * `ama doctor` 用 `describeProxy()` 显示同一份状态；代理 URL 里的账号密码打码。
 */

import * as http from "node:http";

export interface ProxyEnv {
  httpsProxy?: string;
  httpProxy?: string;
  noProxy?: string;
}

export type ProxyState =
  | "none"
  /** 运行时已按环境变量接管（NODE_USE_ENV_PROXY / --use-env-proxy）。 */
  | "runtime"
  /** ama 启动时调用 http.setGlobalProxyFromEnv() 启用。 */
  | "enabled"
  /** 设了代理变量，但当前 Node 不支持内置代理。 */
  | "unsupported"
  /** 代理 URL 无法解析。 */
  | "invalid";

export interface ProxyStatus {
  env: ProxyEnv;
  state: ProxyState;
  error?: string;
}

type SetGlobalProxy = (env?: NodeJS.ProcessEnv) => () => void;

export interface ProxyRuntime {
  setGlobalProxyFromEnv?: SetGlobalProxy | undefined;
  execArgv: readonly string[];
  version: string;
}

function pick(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

export function readProxyEnv(env: Readonly<Record<string, string | undefined>>): ProxyEnv {
  const out: ProxyEnv = {};
  const https = pick(env, "https_proxy");
  const plain = pick(env, "http_proxy");
  const no = pick(env, "no_proxy");
  if (https !== undefined) out.httpsProxy = https;
  if (plain !== undefined) out.httpProxy = plain;
  if (no !== undefined) out.noProxy = no;
  return out;
}

export function defaultProxyRuntime(): ProxyRuntime {
  const fn = (http as unknown as { setGlobalProxyFromEnv?: SetGlobalProxy }).setGlobalProxyFromEnv;
  return {
    setGlobalProxyFromEnv: typeof fn === "function" ? fn.bind(http) : undefined,
    execArgv: process.execArgv,
    version: process.versions.node,
  };
}

/** Node ≥ 24，或 22.21+：认 NODE_USE_ENV_PROXY / --use-env-proxy。 */
function runtimeReadsEnvProxy(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

let current: ProxyStatus | undefined;
let hinted = false;

/** 只判断不启用：没设代理 / 运行时已接管 / 能启用 / 不支持 / URL 无法解析。 */
export function inspectProxy(
  env: Readonly<Record<string, string | undefined>>,
  runtime: ProxyRuntime = defaultProxyRuntime(),
): ProxyStatus {
  if (current !== undefined) return current;
  const proxy = readProxyEnv(env);
  if (proxy.httpsProxy === undefined && proxy.httpProxy === undefined)
    return { env: proxy, state: "none" };
  const flagged =
    env["NODE_USE_ENV_PROXY"] === "1" ||
    runtime.execArgv.includes("--use-env-proxy") ||
    (env["NODE_OPTIONS"] ?? "").includes("--use-env-proxy");
  if (flagged && runtimeReadsEnvProxy(runtime.version)) return { env: proxy, state: "runtime" };
  if (runtime.setGlobalProxyFromEnv === undefined) return { env: proxy, state: "unsupported" };
  for (const value of [proxy.httpsProxy, proxy.httpProxy]) {
    if (value !== undefined && !URL.canParse(value))
      return { env: proxy, state: "invalid", error: `无法解析 ${redactProxyUrl(value)}` };
  }
  return { env: proxy, state: "enabled" };
}

/** 按上面的规则启用代理（进程级副作用）；同一进程只做一次，之后返回同一份状态。 */
export function enableEnvProxy(
  env: Readonly<Record<string, string | undefined>>,
  runtime: ProxyRuntime = defaultProxyRuntime(),
): ProxyStatus {
  if (current !== undefined) return current;
  const status = inspectProxy(env, runtime);
  if (status.state === "enabled") {
    try {
      runtime.setGlobalProxyFromEnv?.({ ...env } as NodeJS.ProcessEnv);
    } catch (error) {
      current = { env: status.env, state: "invalid", error: (error as Error).message };
      return current;
    }
  }
  current = status;
  return current;
}

/** 测试用：清掉进程内记住的状态。 */
export function resetProxyForTest(): void {
  current = undefined;
  hinted = false;
}

/** 代理 URL 里的账号密码打码。 */
export function redactProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username === "" && url.password === "") return value;
    url.username = url.username === "" ? "" : "***";
    url.password = url.password === "" ? "" : "***";
    return url.toString();
  } catch {
    return value.replace(/\/\/[^@/]*@/, "//***@");
  }
}

/** 不能启用时给一次 stderr 提示（每个进程至多一次）；能用或没设代理返回 undefined。 */
export function proxyHint(
  status: ProxyStatus,
  nodeVersion = process.versions.node,
): string | undefined {
  if (hinted) return undefined;
  if (status.state === "unsupported") {
    hinted = true;
    return (
      `ama: 检测到 HTTPS_PROXY / HTTP_PROXY，但 Node ${nodeVersion} 的 fetch 不读代理变量，请求将直连；` +
      "升级到 Node 24+，或在 Node 22.21+ 上设 NODE_USE_ENV_PROXY=1\n"
    );
  }
  if (status.state === "invalid") {
    hinted = true;
    return `ama: 代理变量无法解析，请求将直连：${status.error ?? ""}\n`;
  }
  return undefined;
}

/** `ama doctor` 的代理段落。 */
export function describeProxy(status: ProxyStatus): string[] {
  const { env } = status;
  const lines: string[] = [];
  if (env.httpsProxy !== undefined) lines.push(`HTTPS_PROXY=${redactProxyUrl(env.httpsProxy)}`);
  if (env.httpProxy !== undefined) lines.push(`HTTP_PROXY=${redactProxyUrl(env.httpProxy)}`);
  if (env.noProxy !== undefined) lines.push(`NO_PROXY=${env.noProxy}`);
  const state: Record<ProxyState, string> = {
    none: "未设置代理变量：直连",
    runtime: "已启用（Node 按 NODE_USE_ENV_PROXY / --use-env-proxy 接管）",
    enabled: "已启用（ama 启动时调用 Node 内置的 setGlobalProxyFromEnv）",
    unsupported: `✗ 当前 Node ${process.versions.node} 不支持内置代理，请求直连；升级到 Node 24+`,
    invalid: `✗ 代理变量无法解析：${status.error ?? ""}`,
  };
  lines.push(state[status.state]);
  return lines;
}
