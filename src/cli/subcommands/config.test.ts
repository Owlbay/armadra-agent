import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { ProviderRegistry } from "../../ai/providers/registry.js";
import { detectSandboxCapability } from "../../codemode/capability.js";
import { describeCodemode } from "./config.js";
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

  it("补全 cache / codemode 段与来源；codemode 跟随预设写明原因；--codemode / --tools-preset 作为 cli 层；旧名提示", async () => {
    home.write("home/.config/ama/config.json", {
      version: 1,
      tools: { preset: "codemode" },
      cache: { warming: "idle" },
    });
    expect(await ama(["config", "show"])).toBe(0);
    let text = out.join("");
    expect(text).toMatch(/cache\.warming = "idle"\s+user/);
    expect(text).toMatch(/cache\.retention = "short"\s+default/);
    expect(text).toMatch(/cache\.missNotices = true\s+default/);
    expect(text).toMatch(/codemode\.inlineBudget = 3000\s+default/);
    expect(text).toMatch(/codemode\.requireStrict = false\s+default/);
    expect(text).toMatch(/permission\.builtinDeny = true\s+default/);
    expect(text).toMatch(/tools\.preset = "codemode-only"\s+user/);
    expect(text).toMatch(/codemode\.mode = "only"\s+default（跟随预设 codemode-only（Node \d+/);
    expect(text).toContain("工具：codemode（预设 codemode-only，codemode only）");
    expect(text).toContain("tools.preset 写的是旧名 codemode，规范名 codemode-only");
    out = [];
    expect(await ama(["config", "show", "--tools-preset", "minimal", "--codemode", "on"])).toBe(0);
    text = out.join("");
    expect(text).toMatch(/tools\.preset = "minimal"\s+cli/);
    expect(text).toMatch(/codemode\.mode = "on"\s+cli/);
    expect(text).toContain("codemode：on  codemode.mode 显式设置");
    expect(text).toContain("  cli：命令行");
    out = [];
    expect(await ama(["config", "show", "--json", "--tools-preset", "default"])).toBe(0);
    const json = JSON.parse(out.join("")) as {
      codemode: { mode: string; source: string };
      entries: { path: string; source: string }[];
      tools: string[];
    };
    const strict = detectSandboxCapability().strict;
    expect(json.codemode).toMatchObject({ mode: strict ? "on" : "off", source: "preset" });
    expect(json.tools.includes("codemode")).toBe(strict);
    expect(json.entries.find((e) => e.path === "cache.warming")?.source).toBe("user");
    expect(await ama(["config", "show", "--codemode", "always"])).toBe(2);
  });

  it("describeCodemode：default 预设随 Node 版本；requireStrict 时说明不可用", () => {
    expect(describeCodemode({ version: 1 }, "26.1.0")).toMatchObject({
      mode: "on",
      source: "preset",
      reason: "跟随预设 default（Node 26 网络已隔离）",
    });
    expect(describeCodemode({ version: 1 }, "24.3.0")).toMatchObject({
      mode: "off",
      reason: "跟随预设 default（Node 24 < 25 网络未隔离）",
    });
    const strictOnly = describeCodemode(
      { version: 1, codemode: { mode: "on", requireStrict: true } },
      "22.19.0",
    );
    expect(strictOnly.source).toBe("config");
    expect(strictOnly.unavailable).toMatch(/codemode 已禁用/);
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
    expect(out.join("")).toMatch(/codemode：(on|off)（跟随预设 default（Node \d+/);
    expect(out.join("")).toContain("bash 沙箱：关闭（sandbox.bash: off）");
  });

  it("[S2] config show / doctor 显示 bash 沙箱状态（文本与 --json）", async () => {
    home.write("home/.config/ama/config.json", {
      version: 1,
      sandbox: { bash: "auto", network: "allow" },
    });
    expect(await ama(["config", "show"])).toBe(0);
    let text = out.join("");
    expect(text).toMatch(/sandbox\.bash = "auto"\s+user/);
    expect(text).toMatch(/sandbox\.network = "allow"\s+user/);
    expect(text).toMatch(/bash 沙箱：(sandbox-exec|bwrap)，网络 allow|bash 沙箱：不可用/);
    out = [];
    expect(await ama(["config", "show", "--json"])).toBe(0);
    const json = JSON.parse(out.join("")) as { bashSandbox: { active: boolean; detail: string } };
    expect(typeof json.bashSandbox.active).toBe("boolean");
    out = [];
    expect(await ama(["doctor"])).toBe(0);
    text = out.join("");
    expect(text).toMatch(/bash 沙箱：/);
  });

  it("供应商节：模型级协议与 baseUrl 来自环境变量（文本与 --json）；doctor 标出变量", async () => {
    home.write("home/.config/ama/config.json", {
      version: 1,
      providers: {
        relay: {
          baseUrl: "https://relay.example/v1",
          models: [
            // modelsDev:false：本用例只看协议与 baseUrl 的来源，不要快照补字段（快照随包携带）
            { id: "glm-5", api: "anthropic-messages", modelsDev: false },
            { id: "deepseek-v4-flash", modelsDev: false, catalog: false },
          ],
        },
      },
    });
    const env = { OPENAI_BASE_URL: "https://relay.example/v1" };
    expect(await ama(["config", "show"], env)).toBe(0);
    const text = out.join("");
    expect(text).toContain("供应商：\n  openai  ");
    expect(text).toContain("\n  relay  openai-completions  https://relay.example/v1\n");
    expect(text).toContain("    relay/glm-5  anthropic-messages  ctx ? · out 8k\n");
    expect(text).toContain("    relay/deepseek-v4-flash  openai-completions  ctx ? · out 8k\n");
    expect(text).toContain(
      "  openai  openai-completions  https://relay.example/v1（baseUrl 来自环境变量 OPENAI_BASE_URL）",
    );
    expect(text).not.toContain("  anthropic  anthropic-messages");
    out = [];
    expect(await ama(["config", "show", "--json"], env)).toBe(0);
    const json = JSON.parse(out.join("")) as { providers: unknown[] };
    expect(json.providers).toContainEqual({
      id: "openai",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
      baseUrlEnv: "OPENAI_BASE_URL",
      models: [],
    });
    out = [];
    expect(await ama(["doctor"], { ...env, OPENAI_API_KEY: "k" })).toBe(0);
    expect(out.join("")).toMatch(
      /baseUrl 来自环境变量 OPENAI_BASE_URL：https:\/\/relay\.example\/v1（compat 按保守缺省）/,
    );
  });
});
