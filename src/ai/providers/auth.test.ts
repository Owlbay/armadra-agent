import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { ApiKeyResolver, defaultConfigDir, expandEnvRefs, readAuthFile } from "./auth.js";

const provider = {
  id: "deepseek",
  envKeys: ["DEEPSEEK_API_KEY", "AMA_API_KEY_DEEPSEEK"],
  requiresApiKey: true,
};
const node = `"${process.execPath}"`;

let tmp: TmpHome;
let warnings: string[];

beforeEach(() => {
  tmp = createTmpHome();
  warnings = [];
});
afterEach(() => tmp.cleanup());

function writeAuth(rel: string, providers: Record<string, unknown>, mode = 0o600): string {
  const path = tmp.write(rel, { version: 1, providers }, mode);
  chmodSync(path, mode);
  return path;
}

function resolver(extra: ConstructorParameters<typeof ApiKeyResolver>[0] = {}): ApiKeyResolver {
  return new ApiKeyResolver({
    userAuthFile: join(tmp.configDir, "auth.json"),
    env: {},
    onWarning: (m) => warnings.push(m),
    ...extra,
  });
}

describe("key 发现顺序（§3.5）", () => {
  it("① cli > ② --auth-file > ③ 用户级 auth.json > ④ config > ⑤ env", async () => {
    const explicit = writeAuth("explicit/auth.json", { deepseek: { apiKey: "from-explicit" } });
    writeAuth("home/.config/ama/auth.json", { deepseek: { apiKey: "from-user" } });
    const env = { DEEPSEEK_API_KEY: "from-env", CFG: "from-config" };
    const all = {
      cliApiKey: { provider: "deepseek", apiKey: "from-cli" },
      authFile: explicit,
      configKeys: { deepseek: "$CFG" },
      env,
    };
    expect(await resolver(all).resolve(provider)).toEqual({ apiKey: "from-cli", source: "cli" });
    const { cliApiKey: _c, ...noCli } = all;
    expect(await resolver(noCli).resolve(provider)).toEqual({
      apiKey: "from-explicit",
      source: "auth-file",
      origin: explicit,
    });
    const { authFile: _a, ...noExplicit } = noCli;
    expect(await resolver(noExplicit).resolve(provider)).toMatchObject({
      apiKey: "from-user",
      source: "auth-file",
    });
    expect(await resolver({ ...noExplicit, userAuthFile: null }).resolve(provider)).toEqual({
      apiKey: "from-config",
      source: "config",
    });
    expect(await resolver({ env, userAuthFile: null }).resolve(provider)).toEqual({
      apiKey: "from-env",
      source: "env",
      origin: "DEEPSEEK_API_KEY",
    });
    expect(await resolver({ userAuthFile: null }).resolve(provider)).toEqual({
      apiKey: undefined,
      source: "none",
    });
  });

  it("--api-key 只对指定的供应商生效", async () => {
    const r = resolver({ cliApiKey: { provider: "openai", apiKey: "x" } });
    expect((await r.resolve(provider)).source).toBe("none");
  });

  it("env：envKeys 顺序，AMA_API_KEY_<ID> 兜底；空白值跳过；useEnv=false 关闭", async () => {
    expect(
      await resolver({ env: { DEEPSEEK_API_KEY: "  ", AMA_API_KEY_DEEPSEEK: "fallback" } }).resolve(
        provider,
      ),
    ).toMatchObject({ apiKey: "fallback", origin: "AMA_API_KEY_DEEPSEEK" });
    expect(
      (await resolver({ env: { DEEPSEEK_API_KEY: "k" }, useEnv: false }).resolve(provider)).source,
    ).toBe("none");
  });

  it("config 的 $ENV / ${ENV} / $$ 转义；引用缺失视为未配置", () => {
    const env = { A: "aa", B: "bb" };
    expect(expandEnvRefs("$A", env)).toBe("aa");
    expect(expandEnvRefs("${A}-$B", env)).toBe("aa-bb");
    expect(expandEnvRefs("lit$$eral", env)).toBe("lit$eral");
    expect(expandEnvRefs("plain-key", env)).toBe("plain-key");
    expect(expandEnvRefs("$MISSING", env)).toBeUndefined();
    expect(expandEnvRefs("x$MISSING", env)).toBeUndefined();
  });

  it("!command：auth.json 与 config 都支持；结果缓存；失败 / 空输出继续找下一来源", async () => {
    const counter = join(tmp.root, "count.txt");
    const cmd = `${node} -e "const f=require('fs');f.appendFileSync(process.argv[1],'x');console.log('cmd-key')" "${counter}"`;
    writeAuth("home/.config/ama/auth.json", { deepseek: { apiKey: `!${cmd}` } });
    const r = resolver();
    expect(await r.resolve(provider)).toMatchObject({ apiKey: "cmd-key", source: "auth-file" });
    expect(await r.resolve(provider)).toMatchObject({ apiKey: "cmd-key" });
    expect(tmp.read("count.txt")).toBe("x");

    writeAuth("home/.config/ama/auth.json", {
      deepseek: { apiKey: `!${node} -e "process.exit(3)"` },
    });
    const failing = resolver({ configKeys: { deepseek: `!${node} -e "console.log('cfg-cmd')"` } });
    expect(await failing.resolve(provider)).toEqual({ apiKey: "cfg-cmd", source: "config" });
    expect(warnings.some((w) => w.includes("api key command failed"))).toBe(true);
    expect(warnings.join("\n")).not.toContain("cfg-cmd");
  });

  it("!command 用 auth.json 条目的 env；超时视为未配置", async () => {
    writeAuth("home/.config/ama/auth.json", {
      deepseek: {
        apiKey: `!${node} -e "console.log(process.env.SECRET_SRC)"`,
        env: { SECRET_SRC: "from-entry-env" },
      },
    });
    expect((await resolver().resolve(provider)).apiKey).toBe("from-entry-env");
    writeAuth("home/.config/ama/auth.json", {
      deepseek: { apiKey: `!${node} -e "setTimeout(()=>{},5000)"` },
    });
    const slow = resolver({ commandTimeoutMs: 200 });
    expect((await slow.resolve(provider)).source).toBe("none");
  });

  it("auth.json 非 0600 → warning 并照用；坏 JSON → warning 并忽略", async () => {
    if (process.platform !== "win32") {
      writeAuth("home/.config/ama/auth.json", { deepseek: { apiKey: "loose" } }, 0o644);
      expect((await resolver().resolve(provider)).apiKey).toBe("loose");
      expect(warnings.some((w) => w.includes("0644") && w.includes("0600"))).toBe(true);
    }
    chmodSync(tmp.write("home/.config/ama/auth.json", "{oops"), 0o600);
    warnings = [];
    expect(readAuthFile(join(tmp.configDir, "auth.json"), (m) => warnings.push(m))).toBeUndefined();
    expect(warnings[0]).toMatch(/not a valid auth.json/);
    expect(readAuthFile(join(tmp.root, "missing.json"), (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("hasConfiguredKey 不执行命令", () => {
    writeAuth("home/.config/ama/auth.json", { deepseek: { apiKey: "!definitely-not-run" } });
    expect(resolver().hasConfiguredKey(provider)).toBe(true);
    expect(
      resolver({ userAuthFile: null, configKeys: { deepseek: "$NOPE" } }).hasConfiguredKey(
        provider,
      ),
    ).toBe(false);
    expect(
      resolver({ userAuthFile: null, env: { DEEPSEEK_API_KEY: "k" } }).hasConfiguredKey(provider),
    ).toBe(true);
  });

  it("defaultConfigDir", () => {
    expect(defaultConfigDir({ AMA_CONFIG_DIR: "/x" })).toBe("/x");
    if (process.platform !== "win32") {
      expect(defaultConfigDir({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "ama"));
      expect(defaultConfigDir({ HOME: "/h" })).toBe(join("/h", ".config", "ama"));
    }
  });
});
