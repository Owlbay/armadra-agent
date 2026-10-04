import { afterEach, describe, expect, it } from "vitest";
import { assertAcpWire, validateAcp } from "../../../test/helpers/acp-schema.js";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import type { Runtime } from "../../cli/runtime.js";
import { RPC_ERRORS, type AcpSessionConfigOption } from "../../drivers/acp/types.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import { setLocale } from "../../i18n/index.js";
import {
  applyConfigOption,
  availableCommands,
  buildConfigOptions,
  prepareConfigOptions,
} from "./acp-config.js";

let h: ComposeHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
  setLocale("zh");
});

const SHOW_FAKE = { AMA_SHOW_FAKE: "1" };

async function boot(env: Record<string, string> = {}, model = "fake/echo"): Promise<Runtime> {
  h = composeHarness(undefined, { env });
  return h.boot(["--mode", "rpc", "--model", model]);
}

/** 选择项的全部可选值（分组展开）。 */
function values(option: AcpSessionConfigOption | undefined): string[] {
  return (option?.options ?? []).flatMap((o) =>
    "options" in o ? o.options.map((x) => x.value) : [o.value],
  );
}

function groups(option: AcpSessionConfigOption | undefined): string[] {
  return (option?.options ?? []).map((o) => ("group" in o ? o.group : "<flat>"));
}

const byId = (options: AcpSessionConfigOption[], id: string) => options.find((o) => o.id === id);

describe("buildConfigOptions", () => {
  it("model 按供应商分组、值 provider/model-id；thinking 只列当前模型支持的级别；没有 mode 类别", async () => {
    const runtime = await boot();
    await prepareConfigOptions(runtime.providers);
    const options = buildConfigOptions(runtime.session, runtime.providers, SHOW_FAKE);
    expect(options.map((o) => [o.id, o.category, o.type])).toEqual([
      ["model", "model", "select"],
      ["thinking", "thought_level", "select"],
    ]);
    expect(options.some((o) => o.category === "mode")).toBe(false);
    const model = byId(options, "model")!;
    expect(model.currentValue).toBe("fake/echo");
    expect(values(model)).toEqual(expect.arrayContaining(["fake/echo", "fake/reasoning"]));
    // 全部分组（schema 不允许平铺与分组混排）
    expect(groups(model)).not.toContain("<flat>");
    expect(groups(model)).toContain("fake");
    // fake/echo 不是推理模型：只有 off
    const thinking = byId(options, "thinking")!;
    expect(values(thinking)).toEqual(["off"]);
    expect(thinking.currentValue).toBe("off");
    for (const option of options) expect(validateAcp("SessionConfigOption", option)).toEqual([]);
  });

  it("只列已配 key / 本地可用的供应商（Q3）；准备之后有 key 的供应商才出现", async () => {
    const runtime = await boot({ ANTHROPIC_API_KEY: "test-key" });
    const before = buildConfigOptions(runtime.session, runtime.providers, SHOW_FAKE);
    expect(groups(byId(before, "model"))).not.toContain("anthropic");
    await prepareConfigOptions(runtime.providers);
    const after = byId(buildConfigOptions(runtime.session, runtime.providers, SHOW_FAKE), "model");
    expect(groups(after)).toContain("anthropic");
    expect(groups(after)).not.toContain("openai");
    expect(values(after).every((v) => /^[^/]+\/.+/.test(v))).toBe(true);
  });

  it("fake 按 hideFakeProvider 规则藏起，但当前模型总在列", async () => {
    const runtime = await boot({ ANTHROPIC_API_KEY: "test-key" });
    await prepareConfigOptions(runtime.providers);
    const model = byId(buildConfigOptions(runtime.session, runtime.providers, {}), "model")!;
    expect(values(model)).toContain("fake/echo");
    expect(values(model)).not.toContain("fake/reasoning");
  });

  it("models.enabled 只列清单内的（与 /model 的已配置视图同口径）", async () => {
    const runtime = await boot();
    await prepareConfigOptions(runtime.providers);
    const model = byId(
      buildConfigOptions(runtime.session, runtime.providers, SHOW_FAKE, {
        enabled: ["fake/reasoning"],
      }),
      "model",
    )!;
    expect(values(model).sort()).toEqual(["fake/echo", "fake/reasoning"]);
  });

  it("推理模型列出支持的级别；名称走 i18n", async () => {
    const runtime = await boot({}, "fake/reasoning");
    setLocale("en");
    const thinking = byId(
      buildConfigOptions(runtime.session, runtime.providers, SHOW_FAKE),
      "thinking",
    )!;
    expect(values(thinking)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(thinking.name).toBe("Thinking level");
    expect(values(thinking)).toContain(thinking.currentValue);
  });
});

describe("applyConfigOption", () => {
  it("设模型与思考级别，之后 buildConfigOptions 反映新状态", async () => {
    const runtime = await boot();
    const session = runtime.session;
    await applyConfigOption(session, {
      sessionId: "s",
      configId: "model",
      value: "fake/reasoning",
    });
    expect(session.state.model).toMatchObject({ provider: "fake", id: "reasoning" });
    await applyConfigOption(session, { sessionId: "s", configId: "thinking", value: "high" });
    expect(session.state.thinkingLevel).toBe("high");
    const options = buildConfigOptions(session, runtime.providers, SHOW_FAKE);
    expect(byId(options, "model")?.currentValue).toBe("fake/reasoning");
    expect(byId(options, "thinking")?.currentValue).toBe("high");
    // 答复形状过 schema
    assertAcpWire([
      {
        dir: "in",
        msg: {
          jsonrpc: "2.0",
          id: 1,
          method: "session/set_config_option",
          params: { sessionId: "s", configId: "thinking", value: "high" },
        },
      },
      { dir: "out", msg: { jsonrpc: "2.0", id: 1, result: { configOptions: options } } },
    ]);
  });

  it.each([
    ["未知 id", { configId: "mode", value: "plan" }],
    ["未知模型", { configId: "model", value: "fake/nope" }],
    ["空模型", { configId: "model", value: "" }],
    ["未知级别", { configId: "thinking", value: "max" }],
    ["非字符串值", { configId: "thinking", value: true as unknown as string }],
  ])("%s → invalid params（-32602）", async (_label, params) => {
    const runtime = await boot();
    const error = await applyConfigOption(runtime.session, { sessionId: "s", ...params }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(RPC_ERRORS.invalidParams);
    expect(runtime.session.state.model).toMatchObject({ provider: "fake", id: "echo" });
  });
});

describe("availableCommands", () => {
  it("skills → skill:<name>；提示模板 → <name>，argument-hint → input.hint；不列内置斜杠命令", async () => {
    h = composeHarness();
    h.home.write(
      "home/.config/ama/prompts/review.md",
      "---\ndescription: Review a file\nargument-hint: <path>\n---\nReview $1\n",
    );
    h.home.write("home/.config/ama/prompts/plain.md", "Say hello\n");
    const runtime = await h.boot(["--mode", "rpc", "--model", "fake/echo"]);
    const commands = availableCommands(runtime.resources);
    expect(commands).toEqual(
      expect.arrayContaining([
        { name: "review", description: "Review a file", input: { hint: "<path>" } },
        { name: "plain", description: "Say hello" },
      ]),
    );
    const skills = commands.filter((c) => c.name.startsWith("skill:"));
    expect(skills.length).toBe(runtime.resources.skills.length);
    expect(skills.length).toBeGreaterThan(0);
    for (const name of ["new", "compact", "model", "resume", "help"])
      expect(commands.some((c) => c.name === name)).toBe(false);
    for (const command of commands) expect(validateAcp("AvailableCommand", command)).toEqual([]);
  });
});
