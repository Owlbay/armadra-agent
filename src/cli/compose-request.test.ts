/**
 * 流中空闲超时的读取与下发（docs/history/model-efficiency-plan.md D18）。[ME-C]
 */

import { describe, expect, it } from "vitest";
import type { StreamFn } from "../agent/loop.js";
import type { SessionExtensionContext } from "../agent/session-extensions.js";
import type { StreamOptions } from "../ai/types.js";
import type { ComposeExtensionDeps } from "./compose-extensions.js";
import { requestTimeoutsFactory, streamIdleTimeoutFrom } from "./compose-request.js";

describe("streamIdleTimeoutFrom", () => {
  it("AMA_STREAM_IDLE_TIMEOUT_MS > request.streamIdleTimeoutMs；非法值 warning 后回落", () => {
    const config = { request: { streamIdleTimeoutMs: 90_000 } };
    const warnings: string[] = [];
    expect(streamIdleTimeoutFrom({}, {})).toBeUndefined();
    expect(streamIdleTimeoutFrom(config, {})).toBe(90_000);
    expect(streamIdleTimeoutFrom(config, { AMA_STREAM_IDLE_TIMEOUT_MS: "0" })).toBe(0);
    expect(
      streamIdleTimeoutFrom(config, { AMA_STREAM_IDLE_TIMEOUT_MS: "x" }, (m) => warnings.push(m)),
    ).toBe(90_000);
    expect(warnings[0]).toContain("AMA_STREAM_IDLE_TIMEOUT_MS=x");
    // 等响应头的环境变量不影响流中上限
    expect(streamIdleTimeoutFrom(config, { AMA_IDLE_TIMEOUT_MS: "1000" })).toBe(90_000);
  });
});

describe("requestTimeoutsFactory", () => {
  const deps = (config: object, env: NodeJS.ProcessEnv = {}): ComposeExtensionDeps =>
    ({
      assembly: { config },
      env,
      log: () => undefined,
    }) as unknown as ComposeExtensionDeps;
  const ctx = {} as SessionExtensionContext;
  const seen: Partial<StreamOptions>[] = [];
  const inner: StreamFn = (_model, _context, options) => {
    seen.push(options);
    return undefined as never;
  };

  it("配置了才装；给每次请求补 streamIdleTimeoutMs，已显式给出的不覆盖", () => {
    expect(requestTimeoutsFactory(deps({}))(ctx)).toBeUndefined();
    const extension = requestTimeoutsFactory(deps({ request: { streamIdleTimeoutMs: 45_000 } }))(
      ctx,
    );
    const wrapped = extension?.wrapStream?.(inner);
    const signal = new AbortController().signal;
    wrapped?.({} as never, { messages: [] }, { signal });
    wrapped?.({} as never, { messages: [] }, { signal, streamIdleTimeoutMs: 5 });
    expect(seen.map((o) => o.streamIdleTimeoutMs)).toEqual([45_000, 5]);
    const fromEnv = requestTimeoutsFactory(deps({}, { AMA_STREAM_IDLE_TIMEOUT_MS: "0" }))(ctx);
    expect(fromEnv?.id).toBe("request-timeouts");
  });
});
