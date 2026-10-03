import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { setLocale } from "../../i18n/index.js";
import { buildProviderRegistry } from "../compose-providers.js";
import type { CliIo } from "../deps.js";
import { defaultIo } from "../main.js";
import { runModels } from "./models.js";

let home: TmpHome;
let out: string[];
let err: string[];

beforeEach(() => {
  home = createTmpHome();
  out = [];
  err = [];
});
afterEach(() => {
  home.cleanup();
  setLocale("zh");
});

function io(): CliIo {
  return {
    ...defaultIo(),
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { ...home.env, RELAY_KEY: "sk-relay", AMA_NO_LOCAL_PROBE: "1" },
    cwd: home.cwd,
  };
}

const deps = {
  providers: {
    create: (input: Parameters<typeof buildProviderRegistry>[0]) =>
      buildProviderRegistry(input, { env: io().env, includeFake: false, probeLocal: false }),
  },
};

const configPath = (): string => join(home.configDir, "config.json");
const ORIGINAL = `{
  "version": 1,
  "ui": { "theme": "dark" },
  "providers": {
    "relay": {
      "baseUrl": "https://relay.example/v1",
      "apiKey": "$RELAY_KEY",
      "models": [{ "id": "glm-5" }, { "id": "kimi-k2" }]
    }
  }
}
`;

function written(): { ui?: unknown; providers?: unknown; models?: { enabled?: string[] } } {
  return JSON.parse(readFileSync(configPath(), "utf8"));
}

describe("ama models enable | disable | list --enabled", () => {
  it("enable 写回用户级 models.enabled，其它字段不变、留 .bak；重复加入不再写", async () => {
    writeFileSync(configPath(), ORIGINAL);
    expect(await runModels(["enable", "relay/glm-5", "openai/*"], io(), deps)).toBe(0);
    expect(out.join("")).toContain("已加入 models.enabled：relay/glm-5, openai/* → ");
    const after = written();
    expect(after.models?.enabled).toEqual(["relay/glm-5", "openai/*"]);
    expect(after.ui).toEqual({ theme: "dark" });
    expect(after.providers).toEqual(JSON.parse(ORIGINAL).providers);
    expect(readFileSync(`${configPath()}.bak`, "utf8")).toBe(ORIGINAL);
    out = [];
    expect(await runModels(["enable", "relay/glm-5"], io(), deps)).toBe(0);
    expect(out.join("")).toContain("已在 models.enabled 里：relay/glm-5");
  });

  it("引用校验：格式不对 → 2；供应商不存在 → 4；模型不在表里只警告", async () => {
    writeFileSync(configPath(), ORIGINAL);
    await expect(runModels(["enable", "glm-5"], io(), deps)).rejects.toThrow(
      /provider\/model\[@channel\]/,
    );
    expect(await runModels(["enable", "nope/x"], io(), deps)).toBe(4);
    expect(err.join("")).toContain("nope");
    err = [];
    expect(await runModels(["enable", "relay/not-there"], io(), deps)).toBe(0);
    expect(err.join("")).toContain("relay/not-there 不在模型表里，照样写入");
    expect(written().models?.enabled).toEqual(["relay/not-there"]);
  });

  it("disable 移出；移空时删掉键；不在清单里 → 1", async () => {
    writeFileSync(configPath(), ORIGINAL);
    await runModels(["enable", "relay/glm-5", "relay/kimi-k2"], io(), deps);
    out = [];
    expect(await runModels(["disable", "relay/glm-5"], io(), deps)).toBe(0);
    expect(written().models?.enabled).toEqual(["relay/kimi-k2"]);
    expect(await runModels(["disable", "relay/glm-5"], io(), deps)).toBe(1);
    expect(err.join("")).toContain("不在 models.enabled 里：relay/glm-5");
    expect(await runModels(["disable", "relay/kimi-k2"], io(), deps)).toBe(0);
    expect(out.join("")).toContain("models.enabled 已清空并删除");
    expect(written().models).toBeUndefined();
    expect(written().ui).toEqual({ theme: "dark" });
  });

  it("list --enabled：有清单列清单与供应商状态；没清单列已配置供应商的模型", async () => {
    writeFileSync(configPath(), ORIGINAL);
    expect(await runModels(["list", "--enabled"], io(), deps)).toBe(0);
    const unset = out.join("");
    expect(unset).toContain("未设置 models.enabled");
    expect(unset).toContain("  relay/glm-5  key ✓\n");
    expect(unset).not.toContain("openai/");
    await runModels(["enable", "relay/glm-5", "openai/*", "relay/ghost"], io(), deps);
    out = [];
    expect(await runModels(["list", "--enabled"], io(), deps)).toBe(0);
    expect(out.join("")).toContain("  relay/glm-5  key ✓\n");
    expect(out.join("")).toContain("  openai/*  未配置 key\n");
    expect(out.join("")).toContain("  relay/ghost  key ✓ · 不在模型表里\n");
  });

  it("没有 config.json 时 enable 建一份最小配置；项目级 .ama/config.json 里的 models.enabled 不算", async () => {
    expect(existsSync(configPath())).toBe(false);
    mkdirSync(join(home.cwd, ".ama"), { recursive: true });
    writeFileSync(
      join(home.cwd, ".ama", "config.json"),
      JSON.stringify({ version: 1, models: { enabled: ["relay/glm-5"] } }),
    );
    expect(await runModels(["list", "--enabled"], io(), deps)).toBe(0);
    expect(out.join("")).toContain("未设置 models.enabled");
    expect(await runModels(["enable", "openai/gpt-5"], io(), deps)).toBe(0);
    expect(written().models?.enabled).toEqual(["openai/gpt-5"]);
    expect(JSON.parse(readFileSync(join(home.cwd, ".ama", "config.json"), "utf8"))).toEqual({
      version: 1,
      models: { enabled: ["relay/glm-5"] },
    });
  });

  it("en 文案", async () => {
    setLocale("en");
    writeFileSync(configPath(), ORIGINAL);
    expect(await runModels(["enable", "relay/glm-5"], io(), deps)).toBe(0);
    expect(out.join("")).toContain("Added to models.enabled: relay/glm-5 → ");
  });
});
