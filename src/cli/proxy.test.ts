import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeProxy,
  enableEnvProxy,
  inspectProxy,
  proxyHint,
  readProxyEnv,
  redactProxyUrl,
  resetProxyForTest,
  type ProxyRuntime,
} from "./proxy.js";

afterEach(() => resetProxyForTest());

function runtime(extra: Partial<ProxyRuntime> = {}): ProxyRuntime {
  return {
    execArgv: [],
    version: "24.21.0",
    setGlobalProxyFromEnv: vi.fn(() => () => {}),
    ...extra,
  };
}

describe("环境变量代理", () => {
  it("读大小写两种写法；空值忽略", () => {
    expect(
      readProxyEnv({
        https_proxy: "http://p:1",
        HTTP_PROXY: "http://q:2",
        NO_PROXY: "",
        no_proxy: "",
      }),
    ).toEqual({ httpsProxy: "http://p:1", httpProxy: "http://q:2" });
  });

  it("没设代理：什么都不做", () => {
    const rt = runtime();
    expect(enableEnvProxy({}, rt).state).toBe("none");
    expect(rt.setGlobalProxyFromEnv).not.toHaveBeenCalled();
  });

  it("Node 支持：启动时调用一次 setGlobalProxyFromEnv，之后复用状态", () => {
    const rt = runtime();
    const env = { HTTPS_PROXY: "http://127.0.0.1:8080", NO_PROXY: "localhost" };
    expect(enableEnvProxy(env, rt).state).toBe("enabled");
    expect(enableEnvProxy(env, rt).state).toBe("enabled");
    expect(rt.setGlobalProxyFromEnv).toHaveBeenCalledTimes(1);
    expect(rt.setGlobalProxyFromEnv).toHaveBeenCalledWith(expect.objectContaining(env));
  });

  it("运行时已接管（NODE_USE_ENV_PROXY=1 且 Node 认）：不重复设置", () => {
    const rt = runtime({ version: "22.21.0" });
    const status = enableEnvProxy({ HTTPS_PROXY: "http://p:1", NODE_USE_ENV_PROXY: "1" }, rt);
    expect(status.state).toBe("runtime");
    expect(rt.setGlobalProxyFromEnv).not.toHaveBeenCalled();
  });

  it("不支持的 Node：状态 unsupported，联网命令提示一次", () => {
    const rt = runtime({ version: "22.19.0", setGlobalProxyFromEnv: undefined });
    const status = enableEnvProxy({ HTTPS_PROXY: "http://p:1", NODE_USE_ENV_PROXY: "1" }, rt);
    expect(status.state).toBe("unsupported");
    expect(proxyHint(status, "22.19.0")).toContain("Node 22.19.0 的 fetch 不读代理变量");
    expect(proxyHint(status, "22.19.0")).toBeUndefined();
    expect(describeProxy(status).at(-1)).toContain("不支持内置代理");
  });

  it("URL 无法解析 → invalid，不调用", () => {
    const rt = runtime();
    expect(inspectProxy({ HTTPS_PROXY: "not a url" }, rt).state).toBe("invalid");
    expect(enableEnvProxy({ HTTPS_PROXY: "not a url" }, rt).state).toBe("invalid");
    expect(rt.setGlobalProxyFromEnv).not.toHaveBeenCalled();
  });

  it("doctor 文案：账号密码打码", () => {
    expect(redactProxyUrl("http://user:secret@proxy.local:3128")).toBe(
      "http://***:***@proxy.local:3128/",
    );
    const lines = describeProxy(
      inspectProxy({ HTTPS_PROXY: "http://u:pw@p.local:1", NO_PROXY: "localhost" }, runtime()),
    );
    expect(lines.join("\n")).not.toContain("pw");
    expect(lines).toContain("NO_PROXY=localhost");
    expect(lines.at(-1)).toContain("已启用");
  });
});
