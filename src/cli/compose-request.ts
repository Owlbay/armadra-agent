/**
 * 模型请求的流中空闲超时（docs/model-efficiency-plan.md D18）。[ME-C]
 *
 * 等响应头仍由 `request.idleTimeoutMs` / `AMA_IDLE_TIMEOUT_MS`（compose-session.ts `idleTimeoutFrom`）
 * 决定；流开始后两块数据之间的上限读 `AMA_STREAM_IDLE_TIMEOUT_MS` > config
 * `request.streamIdleTimeoutMs`，都没有时协议层取缺省 180 000（ai/http.ts）。
 *
 * `session.ts` 不加行：值经会话扩展的 `wrapStream` 写进每次请求的 `StreamOptions.streamIdleTimeoutMs`
 * （已显式给出的不覆盖）；工厂对主会话与 task 子会话都装（子会话沿用父的扩展表）。
 */

import type { SessionExtensionFactory } from "../agent/session-extensions.js";
import type { AmaConfig } from "../config/types.js";
import { msg } from "../i18n/index.js";
import type { ComposeExtensionDeps } from "./compose-extensions.js";

export const STREAM_IDLE_TIMEOUT_ENV = "AMA_STREAM_IDLE_TIMEOUT_MS";

/** 流中空闲超时：环境变量 > config；都没有 → undefined。0 关闭；非法的环境变量值忽略并 warning。 */
export function streamIdleTimeoutFrom(
  config: Pick<AmaConfig, "request">,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = () => undefined,
): number | undefined {
  const raw = env[STREAM_IDLE_TIMEOUT_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
    warn(msg().cli.composeSession.invalidStreamIdleTimeout(raw));
  }
  return config.request?.streamIdleTimeoutMs;
}

/** 给每次请求补上 `streamIdleTimeoutMs`（调用方已给出的不覆盖）。 */
export function streamIdleExtension(ms: number): SessionExtensionFactory {
  return () => ({
    id: "request-timeouts",
    wrapStream: (stream) => (model, context, options) =>
      stream(
        model,
        context,
        options.streamIdleTimeoutMs === undefined
          ? { ...options, streamIdleTimeoutMs: ms }
          : options,
      ),
  });
}

/** compose-extensions.ts 表里的一行：配置或环境变量给了值才装。 */
export function requestTimeoutsFactory(deps: ComposeExtensionDeps): SessionExtensionFactory {
  const ms = streamIdleTimeoutFrom(deps.assembly.config, deps.env, (message) =>
    deps.log("warn", message),
  );
  return ms === undefined ? () => undefined : streamIdleExtension(ms);
}
