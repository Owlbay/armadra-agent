import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { ProviderRegistry } from "../../ai/providers/registry.js";
import { main } from "../main.js";

let home: TmpHome;
let out: string[];
beforeEach(() => {
  home = createTmpHome();
  out = [];
});
afterEach(() => home.cleanup());

const anthropicFirst = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } }).get(
  "anthropic",
)?.models[0]?.id as string;

function ama(argv: string[], env: Record<string, string> = {}): Promise<number> {
  return main(argv, {
    processHooks: false,
    io: {
      stdout: (t) => void out.push(t),
      stderr: (t) => void out.push(t),
      env: { ...home.env, AMA_NO_LOCAL_PROBE: "1", ...env },
      cwd: home.cwd,
    },
  });
}

describe("ama config show", () => {
  it("每项标来源；零配置模型来自有 key 的供应商", async () => {
    home.write("home/.config/ama/config.json", {
      version: 1,
      thinkingLevel: "high",
      permission: { allow: ["bash(git status*)"] },
      providers: { proxy: { baseUrl: "https://x", apiKey: "sk-literal-secret" } },
    });
    home.write("work/.ama/config.json", {
      version: 1,
      permission: { deny: ["write(secret/**)"] },
      tools: { preset: "minimal" },
    });
    expect(await ama(["config", "show"], { ANTHROPIC_API_KEY: "sk-ant-test" })).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/thinkingLevel = "high"\s+user/);
    expect(text).toMatch(/tools\.preset = "minimal"\s+project/);
    expect(text).toMatch(/compaction\.enabled = true\s+default/);
    expect(text).toMatch(/permission\.allow = \["bash\(git status\*\)"\]\s+user/);
    expect(text).toMatch(/permission\.deny = \["write\(secret\/\*\*\)"\]\s+project/);
    expect(text).toContain("<literal key>");
    expect(text).not.toContain("sk-literal-secret");
    expect(text).not.toContain("sk-ant-test");
    expect(text).toContain(
      `模型：anthropic/${anthropicFirst}  零配置：anthropic 有 key（env ANTHROPIC_API_KEY）`,
    );
    expect(text).toContain("工具：bash, edit, read, write（预设 minimal，codemode off）");
  });

  it("--json；defaultModel 优先；没有 key 时说明原因", async () => {
    expect(await ama(["config", "show", "--json"])).toBe(0);
    const json = JSON.parse(out.join("")) as { model: { ref?: string; reason: string } };
    expect(json.model.ref).toBeUndefined();
    expect(json.model.reason).toContain("没有可用模型");
    out = [];
    home.write("home/.config/ama/config.json", { version: 1, defaultModel: "fake/echo" });
    expect(await ama(["config"])).toBe(0);
    expect(out.join("")).toContain("模型：fake/echo  config.defaultModel");
    expect(await ama(["config", "frob"])).toBe(2);
  });

  it("doctor 也给出将使用的模型", async () => {
    expect(await ama(["doctor"], { DEEPSEEK_API_KEY: "k" })).toBe(0);
    expect(out.join("")).toMatch(/将使用的模型：deepseek\/\S+（零配置：deepseek 有 key/);
  });
});
