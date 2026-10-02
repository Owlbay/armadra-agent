import { describe, expect, it } from "vitest";
import {
  catalogInherited,
  inheritedFields,
  loadBuiltinCatalog,
  parseCatalogFile,
  redundantFields,
  resolveCatalogEntry,
  snapshotRefOf,
  toModel,
  type CatalogSourceFile,
} from "./catalog.js";
import { catalogMetadata } from "./enrich.js";
import { ModelsDevIndex, modelsDevFields } from "./models-dev.js";
import { builtinSnapshot, builtinSnapshotIndex, mergeSnapshot } from "./models-dev-snapshot.js";

const snap = (ref: string) => {
  const model = builtinSnapshotIndex().get(ref);
  if (model === undefined) throw new Error(`快照里没有 ${ref}`);
  return modelsDevFields(model, "catalog");
};

const file = (models: CatalogSourceFile["models"], modelsDev: string | false = "anthropic") => ({
  version: 1 as const,
  provider: "acme",
  modelsDev,
  models,
});

describe("目录「快照 ⊕ 覆盖」", () => {
  it("只写 id 的条目从快照继承数值事实；目录写的 ama 特有字段保留", () => {
    const opus = snap("anthropic/claude-opus-5-5");
    const parsed = parseCatalogFile(
      file([
        { id: "claude-opus-5-5", promptCache: { short: 300 }, compat: { adaptiveThinking: true } },
      ]),
      "t",
    );
    expect(parsed.models[0]).toEqual({
      id: "claude-opus-5-5",
      name: opus.name,
      reasoning: opus.reasoning,
      contextWindow: opus.contextWindow,
      maxTokens: opus.maxTokens,
      input: opus.input,
      cost: opus.cost,
      family: "claude-opus",
      ...(opus.knowledge !== undefined ? { knowledge: opus.knowledge } : {}),
      ...(opus.releaseDate !== undefined ? { releaseDate: opus.releaseDate } : {}),
      promptCache: { short: 300 },
      compat: { adaptiveThinking: true },
    });
  });

  it("覆盖项优先；cost 按键合并；modelsDev 显式条目 / false", () => {
    const opus = snap("anthropic/claude-opus-5-5");
    const { model, inherited } = resolveCatalogEntry(
      { id: "x", maxTokens: 1000, cost: { cacheWrite: 0 }, modelsDev: "anthropic/claude-opus-5-5" },
      inheritedFields(
        { modelsDev: "anthropic" },
        { id: "x", modelsDev: "anthropic/claude-opus-5-5" },
      ),
    );
    expect(model.maxTokens).toBe(1000);
    expect(model.cost).toEqual({ ...opus.cost, cacheWrite: 0 });
    expect(model).not.toHaveProperty("modelsDev");
    expect(inherited).not.toContain("maxTokens");
    expect(inherited).not.toContain("cost");
    expect(inherited).toContain("contextWindow");
    expect(snapshotRefOf({ modelsDev: "anthropic" }, { id: "a" })).toBe("anthropic/a");
    expect(
      snapshotRefOf({ modelsDev: "anthropic" }, { id: "a", modelsDev: false }),
    ).toBeUndefined();
    expect(snapshotRefOf({ modelsDev: false }, { id: "a" })).toBeUndefined();
  });

  it("目录把窗口调小时，不保留继承来的更大输入上限", () => {
    const { model, inherited } = resolveCatalogEntry(
      { id: "m", contextWindow: 100 },
      { name: "M", reasoning: false, maxTokens: 10, contextWindow: 1000, inputLimit: 900 },
    );
    expect(model.inputLimit).toBeUndefined();
    expect(inherited).not.toContain("inputLimit");
    expect(
      resolveCatalogEntry({ id: "m" }, { contextWindow: 1000, inputLimit: 900 }).model.inputLimit,
    ).toBe(900);
  });

  it("快照里没有的条目必须自己写齐必填字段；cost 写一部分时其余要能继承", () => {
    expect(() => parseCatalogFile(file([{ id: "not-in-snapshot" }]), "t")).toThrowError(
      /\$\.models\[0\]\.name.*\$\.models\[0\]\.reasoning.*\$\.models\[0\]\.maxTokens/,
    );
    expect(() =>
      parseCatalogFile(
        file([{ id: "n", name: "N", reasoning: false, maxTokens: 1, cost: { input: 1 } }]),
        "t",
      ),
    ).toThrowError(/cost\.output.*cost\.cacheRead.*cost\.cacheWrite/);
    expect(() => parseCatalogFile({ ...file([]), modelsDev: 3 }, "t")).toThrowError(
      /\$\.modelsDev/,
    );
    expect(() => parseCatalogFile(file([{ id: "a", _reason: 1 } as never]), "t")).toThrowError(
      /_reason/,
    );
  });

  it("冗余：与快照相同的字段（cost 逐键）报出；_reason 的条目不查", () => {
    const opus = snap("anthropic/claude-opus-5-5");
    const base = inheritedFields({ modelsDev: "anthropic" }, { id: "claude-opus-5-5" });
    expect(
      redundantFields(
        {
          id: "claude-opus-5-5",
          name: opus.name as string,
          maxTokens: 1,
          cost: { input: opus.cost?.input as number, output: 999 },
          promptCache: { short: 300 },
        },
        base,
      ),
    ).toEqual(["name", "cost.input"]);
    expect(
      redundantFields(
        { id: "claude-opus-5-5", name: opus.name as string, _reason: "钉住：上游常改名" },
        base,
      ),
    ).toEqual([]);
  });

  it("传入「快照 ⊕ 刷新」的索引：目录吃刷新后的值；刷新数据缺字段的条目退回内置快照", () => {
    const haiku = snap("anthropic/claude-haiku-4-5");
    const refreshed = new ModelsDevIndex(
      mergeSnapshot(builtinSnapshot(), {
        anthropic: {
          id: "anthropic",
          models: {
            "claude-opus-5-5": {
              id: "claude-opus-5-5",
              name: "Opus Renamed",
              reasoning: true,
              limit: { context: 5000, output: 100 },
            },
            // 上游改版丢了 name / output：这一条退回内置快照，不让启动失败
            "claude-haiku-4-5": { id: "claude-haiku-4-5", limit: { context: 7 } },
          },
        },
      }),
    );
    const parsed = parseCatalogFile(
      file([{ id: "claude-opus-5-5" }, { id: "claude-haiku-4-5" }]),
      "t",
      refreshed,
    );
    expect(parsed.models[0]).toMatchObject({ name: "Opus Renamed", contextWindow: 5000 });
    expect(parsed.models[1]).toMatchObject({
      name: haiku.name,
      contextWindow: haiku.contextWindow,
    });
    // loadBuiltinCatalog 按索引分别缓存；缺省用内置快照
    expect(loadBuiltinCatalog(refreshed)).toEqual(loadBuiltinCatalog(refreshed));
  });

  it("来源：继承的字段标 models.dev，目录写的标 catalog", () => {
    const catalog = loadBuiltinCatalog();
    const entry = catalog.get("anthropic")?.find((m) => m.id === "claude-opus-5-5");
    expect(entry).toBeDefined();
    const inherited = catalogInherited("anthropic", "claude-opus-5-5");
    const meta = catalogMetadata(toModel(entry!, "anthropic", "anthropic-messages"));
    for (const field of ["contextWindow", "maxTokens", "input", "reasoning", "cost"] as const)
      expect(meta.sources[field], field).toBe(inherited.includes(field) ? "models.dev" : "catalog");
  });
});
