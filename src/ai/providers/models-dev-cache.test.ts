import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderRegistry } from "../../cli/compose-providers.js";
import {
  MODELS_DEV_URL,
  describeModelsDev,
  describeRefresh,
  loadModelsDevIndex,
  modelsDevCachePath,
  modelsDevUrl,
  readModelsDevCache,
  refreshModelsDev,
  writeModelsDevCache,
} from "./models-dev-cache.js";
import {
  builtinSnapshot,
  builtinSnapshotIndex,
  snapshotMeta,
  toSnapshotFile,
} from "./models-dev-snapshot.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ama-mdev-"));
  dirs.push(dir);
  return dir;
}

/** 由内置快照还原一份「api.json」（清单里每家都在），再按需改动。 */
function rawApi(): Record<string, { models: Record<string, Record<string, unknown>> }> {
  const out: Record<string, { models: Record<string, Record<string, unknown>> }> = {};
  for (const provider of Object.values(builtinSnapshot()))
    out[provider.id] = structuredClone(toSnapshotFile(provider)) as never;
  out["noise"] = { models: { x: { limit: { context: 1 } } } };
  return out;
}

interface Call {
  url: string;
}

function fakeFetch(responses: (() => Response)[], calls: Call[] = []) {
  const fn = vi.fn(async (url: string | URL | Request) => {
    calls.push({ url: String(url) });
    const next = responses.shift();
    if (!next) throw new Error("offline");
    return next();
  });
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

const json = (body: unknown) => () => Response.json(body);
const later = (ms = 1000) => Date.parse(snapshotMeta().fetchedAt) + ms;

describe("models.dev：快照 ⊕ 覆盖", () => {
  it("没有覆盖文件：直接用内置快照，不联网", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const dir = tmp();
    const index = loadModelsDevIndex(dir);
    expect(index).toBe(builtinSnapshotIndex());
    expect(index.get("anthropic/claude-opus-5-5")?.limit?.context).toBeGreaterThan(0);
    expect(describeModelsDev(dir)).toMatch(/^models\.dev：快照 \S+（\d+ 家供应商、\d+ 个模型）$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("启动零网络：组装注册表并补全自定义模型时 fetch 不被调用", async () => {
    const fetch = vi.fn(async () => new Response("no", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const registry = await buildProviderRegistry(
      {
        config: {
          version: 1,
          providers: {
            relay: {
              api: "anthropic-messages",
              baseUrl: "https://relay.example",
              models: [{ id: "claude-opus-5-5" }],
            },
          },
        },
        cwd: tmp(),
        dataDir: tmp(),
        authFile: join(tmp(), "auth.json"),
        authEnv: false,
      },
      { env: {}, includeFake: false, probeLocal: false },
    );
    const found = registry.findModel("relay/claude-opus-5-5");
    expect(found.ok && found.model.contextWindow).toBe(
      builtinSnapshotIndex().get("anthropic/claude-opus-5-5")?.limit?.context,
    );
    expect(found.ok && found.model.family).toBe("claude-opus");
    expect(registry.findModel("anthropic/claude-opus-5-5").ok).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("覆盖文件晚于快照才叠加；同 provider/model 以覆盖为准，其余沿用快照", () => {
    const dir = tmp();
    const write = (fetchedAt: number): void =>
      writeModelsDevCache(dir, {
        version: 2,
        url: MODELS_DEV_URL,
        fetchedAt: new Date(fetchedAt).toISOString(),
        providers: {
          anthropic: {
            id: "anthropic",
            models: {
              "claude-opus-5-5": { id: "claude-opus-5-5", limit: { context: 7 } },
              "claude-new": { id: "claude-new", limit: { context: 9 } },
            },
          },
        },
      });
    write(later());
    const merged = loadModelsDevIndex(dir);
    expect(merged.get("anthropic/claude-opus-5-5")?.limit?.context).toBe(7);
    expect(merged.get("anthropic/claude-new")?.limit?.context).toBe(9);
    expect(merged.get("anthropic/claude-haiku-4-5")).toEqual(
      builtinSnapshotIndex().get("anthropic/claude-haiku-4-5"),
    );
    expect(merged.get("openai/gpt-5.4-mini")).toBeDefined();
    expect(describeModelsDev(dir)).toContain("⊕ 刷新");
    // 内置快照比覆盖新（升级 ama 之后）：覆盖不再生效
    write(Date.parse(snapshotMeta().fetchedAt) - 1000);
    expect(loadModelsDevIndex(dir)).toBe(builtinSnapshotIndex());
  });

  it("旧版（version 1）与损坏的覆盖文件视为没有", () => {
    const dir = tmp();
    writeFileSync(
      modelsDevCachePath(dir),
      JSON.stringify({ version: 1, fetchedAt: new Date(later()).toISOString(), providers: {} }),
    );
    expect(readModelsDevCache(dir)).toBeUndefined();
    expect(loadModelsDevIndex(dir)).toBe(builtinSnapshotIndex());
    writeFileSync(modelsDevCachePath(dir), "{not json");
    expect(loadModelsDevIndex(dir)).toBe(builtinSnapshotIndex());
  });
});

describe("refreshModelsDev（只被 ama models refresh 调用）", () => {
  it("拉取、按清单裁剪、写覆盖并给出新增 / 删除 / 变价", async () => {
    const dir = tmp();
    const raw = rawApi();
    const anthropic = raw["anthropic"]!.models;
    anthropic["claude-brand-new"] = {
      name: "New",
      tool_call: true,
      limit: { context: 1000, output: 10 },
      description: "drop me",
    };
    anthropic["claude-gone"] = { limit: { context: 5 }, status: "deprecated" };
    (anthropic["claude-opus-5-5"]!["cost"] as Record<string, number>)["input"] = 99;
    delete anthropic["claude-haiku-4-5"];
    const f = fakeFetch([json(raw)]);
    const result = await refreshModelsDev({ dataDir: dir, fetch: f, env: {}, now: () => later() });
    expect(f.calls[0]?.url).toBe(MODELS_DEV_URL);
    expect(result.status).toBe("updated");
    expect(result.diff?.added).toEqual(["anthropic/claude-brand-new"]);
    expect(result.diff?.removed).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(result.diff?.changed).toEqual([
      "anthropic/claude-opus-5-5：cost 4/20/0.2/5 → 99/20/0.2/5",
    ]);
    const file = readModelsDevCache(dir);
    expect(file?.providers["noise"]).toBeUndefined();
    expect(file?.providers["anthropic"]?.models["claude-gone"]).toBeUndefined();
    expect(JSON.stringify(file)).not.toContain("drop me");
    expect(result.index.get("anthropic/claude-brand-new")?.name).toBe("New");
    expect(result.index.get("anthropic/claude-opus-5-5")?.cost?.input).toBe(99);
    // 上游删除的条目在快照里保留（同 provider/model 才覆盖）
    expect(result.index.get("anthropic/claude-haiku-4-5")).toBeDefined();
    const text = describeRefresh(result);
    expect(text).toMatch(/^models\.dev：已刷新（\d+ 家供应商、\d+ 个模型，/);
    expect(text).toContain("新增（1）：\n  anthropic/claude-brand-new");
    expect(text).toContain("上游删除（快照里的条目保留）（1）");
  });

  it("--provider 只刷新指定几家，保留覆盖文件里的其它家；内容相同报无变化", async () => {
    const dir = tmp();
    const raw = rawApi();
    raw["openai"]!.models["gpt-extra"] = { limit: { context: 3 } };
    await refreshModelsDev({ dataDir: dir, fetch: fakeFetch([json(raw)]), env: {}, now: later });
    const same = await refreshModelsDev({
      dataDir: dir,
      fetch: fakeFetch([json(raw)]),
      env: {},
      providers: ["anthropic"],
      now: () => later(2000),
    });
    expect(same.status).toBe("unchanged");
    expect(Object.keys(readModelsDevCache(dir)?.providers ?? {})).toContain("openai");
    expect(same.index.get("openai/gpt-extra")).toBeDefined();
    const unknown = await refreshModelsDev({
      dataDir: dir,
      fetch: fakeFetch([]),
      env: {},
      providers: ["nope"],
    });
    expect(unknown.status).toBe("failed");
    expect(unknown.warning).toContain("不在收录清单里：nope");
  });

  it("失败不写文件、沿用现有数据：网络错误、HTTP 错误、上游缺清单里的供应商", async () => {
    const dir = tmp();
    const offline = await refreshModelsDev({ dataDir: dir, fetch: fakeFetch([]), env: {} });
    expect(offline).toMatchObject({ status: "failed" });
    expect(offline.warning).toMatch(/offline/);
    expect(offline.index).toBe(builtinSnapshotIndex());
    const http = await refreshModelsDev({
      dataDir: dir,
      fetch: fakeFetch([() => new Response("x", { status: 500 })]),
      env: {},
    });
    expect(http.warning).toMatch(/HTTP 500/);
    const raw = rawApi();
    delete raw["xai"];
    const missing = await refreshModelsDev({
      dataDir: dir,
      fetch: fakeFetch([json(raw)]),
      env: {},
    });
    expect(missing.warning).toContain("缺少供应商 xai");
    expect(existsSync(modelsDevCachePath(dir))).toBe(false);
  });

  it("AMA_MODELS_DEV_URL 换数据源", async () => {
    expect(modelsDevUrl({ AMA_MODELS_DEV_URL: " http://mirror/api.json " })).toBe(
      "http://mirror/api.json",
    );
    const f = fakeFetch([json(rawApi())]);
    const env = { AMA_MODELS_DEV_URL: "http://mirror/api.json" };
    await refreshModelsDev({ dataDir: tmp(), fetch: f, env, now: later });
    expect(f.calls[0]?.url).toBe("http://mirror/api.json");
  });
});
