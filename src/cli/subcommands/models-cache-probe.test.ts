import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { ApiRegistry } from "../../ai/apis/api.js";
import type {
  ApiImplementation,
  Model,
  StreamOptions,
  TranscriptContext,
  Usage,
} from "../../ai/types.js";
import { UsageError } from "../args.js";
import { buildProviderRegistry } from "../compose-providers.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { defaultIo } from "../main.js";
import { judgeProbe, probePrefix, sampleOf } from "./models-cache-probe.js";
import { runModels } from "./models.js";

let home: TmpHome;
let out: string[];
let err: string[];
let calls: { context: TranscriptContext; options: StreamOptions }[];
let script: Partial<Usage>[];

beforeEach(() => {
  home = createTmpHome();
  out = [];
  err = [];
  calls = [];
  script = [];
});
afterEach(() => home.cleanup());

function io(tty = false): CliIo {
  return {
    ...defaultIo(),
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    env: { ...home.env, RELAY_KEY: "sk-relay" },
    cwd: home.cwd,
  };
}

/** fake 协议：第 n 次调用按 script[n] 给 usage（脚本两次响应）。 */
function apis(): ApiRegistry {
  const registry = new ApiRegistry();
  const impl: ApiImplementation = {
    id: "openai-completions",
    stream: (model: Model, context, options) => {
      const usage: Usage = {
        input: 0,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        ...script[calls.length],
      };
      calls.push({ context, options });
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop" as const,
        timestamp: 0,
      };
      return {
        result: async () => message,
        [Symbol.asyncIterator]: async function* () {},
      } as never;
    },
  };
  registry.register(impl);
  return registry;
}

function deps(): Pick<RuntimeDeps, "providers"> {
  return {
    providers: {
      create: (input) =>
        buildProviderRegistry(input, {
          env: { RELAY_KEY: "sk-relay" },
          apis: apis(),
          includeFake: false,
          probeLocal: false,
        }),
    },
  };
}

function writeConfig(model: Record<string, unknown> = {}): void {
  home.write("home/.config/ama/config.json", {
    version: 1,
    providers: {
      relay: {
        baseUrl: "https://relay.example/v1",
        apiKey: "$RELAY_KEY",
        models: [
          { id: "kimi", cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }, ...model },
        ],
      },
    },
  });
}

const probe = (...extra: string[]) =>
  runModels(["cache-probe", "relay/kimi", "--gap-ms", "0", ...extra], io(), deps());

describe("ama models cache-probe [W3-C2]", () => {
  it("reported：第二次读到 ≥ 50% 前缀；两次请求前缀逐字节一致、purpose probe、maxTokens 16、short；目录无 promptCache 时提示寿命未知、不给猜测值", async () => {
    writeConfig();
    script = [
      { input: 2_100, cacheReported: true },
      { input: 100, cacheRead: 2_000, cacheReported: true },
    ];
    expect(await probe("--yes")).toBe(0);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0]!.context)).toBe(JSON.stringify(calls[1]!.context));
    expect(calls[0]!.options).toMatchObject({
      maxTokens: 16,
      cacheRetention: "short",
      purpose: "probe",
      apiKey: "sk-relay",
    });
    const text = out.join("");
    expect(text).toContain(
      "cache-probe relay/kimi（openai-completions）· 前缀约 2048 token · 间隔 0 ms",
    );
    expect(text).toContain("预估花费：$0.0042（两次 × 2048 token × 目录价）");
    expect(text).toContain("#1  input 2100 · cacheRead 0 · cacheWrite 0 · 缓存字段 有");
    expect(text).toContain("#2  input 100 · cacheRead 2000 · cacheWrite 0 · 缓存字段 有");
    expect(text).toContain(
      "usage 字段（openai-completions 读取）：prompt_tokens_details.cached_tokens",
    );
    expect(text).toContain("判定：reported（第二次读到前缀的 95%）");
    expect(text).toContain("建议：目录里没有这个模型的缓存寿命，ama 不保温、也不提前裁剪。");
    expect(text).toContain(
      'providers.relay.modelOverrides: [{ "id": "kimi", "promptCache": { "short": <秒数> } }]',
    );
    expect(text).not.toContain('"short": 300');
  });

  it("silent 与 --json：两次都 0、字段缺失；建议写 compat.cacheReporting；预估写 stderr", async () => {
    writeConfig({ promptCache: { short: 300 } });
    script = [
      { input: 2_100, cacheReported: false },
      { input: 2_100, cacheReported: false },
    ];
    expect(await probe("--yes", "--json", "--tokens", "1024")).toBe(0);
    expect(err.join("")).toContain("预估花费");
    const result = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(result).toMatchObject({
      model: "relay/kimi",
      api: "openai-completions",
      tokens: 1024,
      gapMs: 0,
      verdict: "silent",
      advice:
        '可在 config 里设 providers.relay.compat.cacheReporting: "silent"，状态栏将显示未报告',
      requests: [
        { input: 2_100, cacheRead: 0, cacheWrite: 0, cacheReported: false, promptTokens: 2_100 },
        { input: 2_100, cacheRead: 0, cacheWrite: 0, cacheReported: false, promptTokens: 2_100 },
      ],
    });
    expect(result["estimatedCostUsd"]).toBeCloseTo(0.002176, 6);
  });

  it("silent 但字段存在（恒 0）：建议里提示写入延迟的可能", async () => {
    writeConfig();
    script = [
      { input: 1_700, cacheReported: true },
      { input: 1_700, cacheReported: true },
    ];
    expect(await probe("--yes")).toBe(0);
    expect(out.join("")).toContain("判定：silent（第二次读到前缀的 0%）");
    expect(out.join("")).toContain(
      "响应里有缓存字段但恒为 0；也可能是缓存写入有延迟，可加大 --gap-ms 再测一次",
    );
  });

  it("inconclusive：只有写入或读到不足一半；reported 且目录有 promptCache 时无建议", async () => {
    const s = (p: Partial<Usage>) =>
      sampleOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...p });
    expect(judgeProbe(s({ cacheWrite: 2_000, input: 50 }), s({ input: 2_050 }))).toBe(
      "inconclusive",
    );
    expect(judgeProbe(s({ input: 2_000 }), s({ input: 1_500, cacheRead: 500 }))).toBe(
      "inconclusive",
    );
    expect(judgeProbe(s({ input: 2_000 }), s({ input: 1_000, cacheRead: 1_000 }))).toBe("reported");
    expect(judgeProbe(s({ input: 2_000 }), s({ input: 2_000 }))).toBe("silent");
    writeConfig({ promptCache: { short: 300 } });
    script = [{ input: 2_100 }, { input: 100, cacheRead: 2_000 }];
    expect(await probe("--yes")).toBe(0);
    expect(out.join("")).toContain("缓存字段 ?");
    expect(out.join("")).not.toContain("建议");
  });

  it("非 TTY 没有 --yes → 退出 2 且不发请求；参数校验；别的动作不收 --json", async () => {
    writeConfig();
    expect(await probe()).toBe(2);
    expect(calls).toHaveLength(0);
    expect(err.join("")).toContain("非交互环境需加 --yes");
    // 用法错误抛 UsageError，由 CLI 入口转成退出码 2
    await expect(probe("--yes", "--tokens", "0")).rejects.toThrow(UsageError);
    await expect(runModels(["cache-probe"], io(), deps())).rejects.toThrow(UsageError);
    expect(await runModels(["cache-probe", "relay/none", "--yes"], io(), deps())).toBe(4);
    await expect(runModels(["list", "--json"], io(), deps())).rejects.toThrow("未知选项：--json");
  });

  it("前缀确定、长度按字符 / 4 估算", () => {
    expect(probePrefix(2048)).toBe(probePrefix(2048));
    expect(probePrefix(2048).length).toBeGreaterThanOrEqual(2048 * 4 - 100);
    expect(probePrefix(2048).length).toBeLessThan(2048 * 4 + 100);
  });
});
