import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import {
  loadModelsDevIndex,
  modelsDevCachePath,
  readModelsDevCache,
} from "../../ai/providers/models-dev-cache.js";
import { builtinSnapshot, toSnapshotFile } from "../../ai/providers/models-dev-snapshot.js";
import { buildProviderRegistry } from "../compose-providers.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { defaultIo } from "../main.js";
import { runModels } from "./models.js";

let home: TmpHome;
let out: string[];
let err: string[];
let urls: string[];

beforeEach(() => {
  home = createTmpHome();
  out = [];
  err = [];
  urls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  home.cleanup();
});

function io(env: Record<string, string> = {}): CliIo {
  return {
    ...defaultIo(),
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { ...home.env, ...env },
    cwd: home.cwd,
  };
}

const deps: Pick<RuntimeDeps, "providers"> = {
  providers: {
    create: (input) =>
      buildProviderRegistry(input, { env: {}, includeFake: false, probeLocal: false }),
  },
};

function serve(body: unknown): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return Response.json(body);
  });
}

/** 上游 api.json：anthropic 加一个新模型，其余按内置快照。 */
function upstream(): Record<string, unknown> {
  const raw: Record<string, { models: Record<string, unknown> }> = {};
  for (const provider of Object.values(builtinSnapshot()))
    raw[provider.id] = structuredClone(toSnapshotFile(provider)) as never;
  raw["anthropic"]!.models["claude-next"] = { name: "Claude Next", limit: { context: 2000 } };
  return raw;
}

describe("ama models refresh", () => {
  it("显式联网刷新到数据目录；之后的索引带上新模型", async () => {
    serve(upstream());
    expect(await runModels(["refresh", "--provider", "anthropic"], io(), deps)).toBe(0);
    const text = out.join("");
    expect(urls).toEqual(["https://models.dev/api.json"]);
    expect(text).toMatch(/^内置快照：\S+；正在拉取 models\.dev…\n/);
    expect(text).toContain("models.dev：已刷新");
    expect(text).toContain("新增（1）：\n  anthropic/claude-next");
    expect(text).toContain(`已写入 ${modelsDevCachePath(home.dataDir)}`);
    expect(Object.keys(readModelsDevCache(home.dataDir)?.providers ?? {})).toEqual(["anthropic"]);
    expect(loadModelsDevIndex(home.dataDir).get("anthropic/claude-next")?.name).toBe("Claude Next");
  });

  it("refresh-catalog 是别名；AMA_MODELS_DEV_URL 换源；逗号分隔多家", async () => {
    serve(upstream());
    const env = { AMA_MODELS_DEV_URL: "http://mirror.test/api.json" };
    expect(
      await runModels(["refresh-catalog", "--provider", "anthropic, openai"], io(env), deps),
    ).toBe(0);
    expect(urls).toEqual(["http://mirror.test/api.json"]);
    expect(Object.keys(readModelsDevCache(home.dataDir)?.providers ?? {}).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  it("失败：退出码 1、不写文件、提示沿用现有数据；清单外的供应商同样失败", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await runModels(["refresh"], io(), deps)).toBe(1);
    expect(err.join("")).toContain("models.dev 刷新失败（offline），沿用现有数据");
    expect(existsSync(modelsDevCachePath(home.dataDir))).toBe(false);
    err = [];
    expect(await runModels(["refresh", "--provider", "nope"], io(), deps)).toBe(1);
    expect(err.join("")).toContain("不在收录清单里：nope");
  });

  it("其它 models / providers 命令不联网拉 models.dev", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await runModels(["list", "--provider", "anthropic"], io(), deps)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
