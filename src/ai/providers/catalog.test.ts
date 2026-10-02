import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_PROVIDERS } from "./builtin.js";
import {
  applyModelOverride,
  checkCatalogModel,
  inheritedFields,
  loadBuiltinCatalog,
  parseCatalogFile,
  redundantFields,
  toModel,
  type CatalogEntry,
  type CatalogSourceFile,
} from "./catalog.js";
import { CATALOG_SOURCES } from "./catalog-data.js";
import { inlineJsonModule } from "../../../scripts/lib/inline-json.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, "catalog");

function jsonFiles(): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const file of readdirSync(catalogDir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    out.set(file.replace(/\.json$/, ""), JSON.parse(readFileSync(join(catalogDir, file), "utf8")));
  }
  return out;
}

/** catalog-data.ts 的生成器（UPDATE_CATALOG=1 时写回；之后跑 prettier）。 */
function generate(files: Map<string, unknown>): string {
  return inlineJsonModule({
    header: [
      "由 catalog/*.json 生成，勿手改。重新生成：",
      "UPDATE_CATALOG=1 pnpm vitest run src/ai/providers/catalog.test.ts",
    ],
    exportName: "CATALOG_SOURCES",
    entries: files,
  });
}

/** 条目里与快照相同的覆盖项（`cost.input` 这样的路径）。 */
function redundancy(file: CatalogSourceFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of file.models) {
    const found = redundantFields(entry, inheritedFields(file, entry));
    if (found.length > 0) out.set(entry.id, found);
  }
  return out;
}

/** UPDATE_CATALOG=1：删掉冗余字段写回 catalog/<id>.json（之后跑 prettier）。 */
function prune(id: string, file: CatalogSourceFile): CatalogSourceFile {
  const redundant = redundancy(file);
  if (redundant.size === 0) return file;
  for (const entry of file.models) {
    for (const path of redundant.get(entry.id) ?? []) {
      const [key, sub] = path.split(".") as [keyof CatalogEntry, string | undefined];
      if (sub === undefined) delete entry[key];
      else if (entry.cost !== undefined) {
        delete (entry.cost as Record<string, unknown>)[sub];
        if (Object.keys(entry.cost).length === 0) delete entry.cost;
      }
    }
  }
  writeFileSync(join(catalogDir, `${id}.json`), `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

describe("模型目录", () => {
  it("catalog-data.ts 与 catalog/*.json 一致", () => {
    const files = jsonFiles();
    if (process.env["UPDATE_CATALOG"] === "1") {
      for (const [id, value] of files) files.set(id, prune(id, value as CatalogSourceFile));
      writeFileSync(join(here, "catalog-data.ts"), generate(files));
      return;
    }
    expect(Object.keys(CATALOG_SOURCES).sort()).toEqual([...files.keys()]);
    for (const [id, value] of files)
      expect(JSON.parse(CATALOG_SOURCES[id] ?? "null"), id).toEqual(value);
  });

  it("快照 ⊕ 覆盖：目录条目里与快照取值相同的字段视为冗余（UPDATE_CATALOG=1 自动删）", () => {
    for (const [id, value] of jsonFiles()) {
      const file = value as CatalogSourceFile;
      if (file.modelsDev === undefined) continue;
      expect(Object.fromEntries(redundancy(file)), `catalog/${id}.json`).toEqual({});
    }
  });

  it("每家一份，文件名即供应商 id；有目录的每家 2–15 条", () => {
    const catalog = loadBuiltinCatalog();
    expect([...catalog.keys()].sort()).toEqual(BUILTIN_PROVIDERS.map((p) => p.id).sort());
    for (const [id, models] of catalog) {
      if (id === "ollama" || id === "lmstudio") expect(models).toEqual([]);
      else {
        expect(models.length, id).toBeGreaterThanOrEqual(2);
        expect(models.length, id).toBeLessThanOrEqual(15);
      }
    }
  });

  it("数据合理：窗口 ≥ maxTokens（如有）、价格非负、阶梯阈值递增、思考映射只用已知级别", () => {
    for (const [provider, models] of loadBuiltinCatalog()) {
      for (const model of models) {
        expect(checkCatalogModel(model, `${provider}/${model.id}`)).toEqual([]);
        if (model.contextWindow !== undefined) {
          expect(model.contextWindow, `${provider}/${model.id}`).toBeGreaterThanOrEqual(1000);
        }
        if (!model.reasoning) expect(model.thinkingLevelMap).toBeUndefined();
      }
    }
  });

  it("promptCache 只写有公开依据的值（第三波 §1.4）", () => {
    const catalog = loadBuiltinCatalog();
    const anthropicMin = Object.fromEntries(
      (catalog.get("anthropic") ?? []).map((m) => [m.id, m.promptCache]),
    );
    expect(anthropicMin["claude-fable-5-1"]).toEqual({ short: 300, long: 3600, minTokens: 512 });
    expect(anthropicMin["claude-sonnet-5-5"]?.minTokens).toBe(512);
    expect(anthropicMin["claude-opus-4-8"]?.minTokens).toBe(1024);
    expect(anthropicMin["claude-opus-4-7"]?.minTokens).toBe(2048);
    expect(anthropicMin["claude-haiku-4-5"]?.minTokens).toBe(4096);
    for (const model of catalog.get("anthropic") ?? []) {
      expect(model.promptCache, model.id).toMatchObject({ short: 300, long: 3600 });
      expect([512, 1024, 2048, 4096], model.id).toContain(model.promptCache?.minTokens);
    }
    for (const model of catalog.get("openai") ?? []) {
      expect(model.promptCache, model.id).toEqual({ short: 300, long: 86400, minTokens: 1024 });
    }
    for (const model of catalog.get("moonshot") ?? []) {
      expect(model.promptCache, model.id).toEqual({ short: 300 });
    }
    const unpromised = ["deepseek", "zhipu", "dashscope", "groq", "xai", "mistral", "openrouter"];
    for (const id of [...unpromised, "google"]) {
      for (const model of catalog.get(id) ?? [])
        expect(model.promptCache, model.id).toBeUndefined();
    }
  });

  it("promptCache 校验：正整数、只认 short / long / minTokens、long ≥ short", () => {
    const entry = (promptCache: unknown) => ({
      id: "a",
      name: "a",
      reasoning: false,
      maxTokens: 1,
      promptCache,
    });
    expect(checkCatalogModel(entry({ short: 300, long: 3600, minTokens: 1024 }), "m")).toEqual([]);
    expect(checkCatalogModel(entry({ short: "5m" }), "m")).toEqual(["m.promptCache.short"]);
    expect(checkCatalogModel(entry({ ttl: 1 }), "m")).toEqual(["m.promptCache.ttl"]);
    expect(checkCatalogModel(entry({ minTokens: 0 }), "m")).toEqual(["m.promptCache.minTokens"]);
    expect(checkCatalogModel(entry({ short: 600, long: 300 }), "m")).toEqual([
      "m.promptCache.long < short",
    ]);
    expect(checkCatalogModel(entry([]), "m")).toEqual(["m.promptCache"]);
  });

  it("校验报出具体字段", () => {
    expect(() =>
      parseCatalogFile({ version: 1, provider: "x", models: [{ id: "a" }] }, "t"),
    ).toThrowError(/\$\.models\[0\]\.name.*\$\.models\[0\]\.reasoning.*\$\.models\[0\]\.maxTokens/);
    expect(() =>
      parseCatalogFile(
        {
          version: 1,
          provider: "x",
          models: [
            {
              id: "a",
              name: "a",
              reasoning: false,
              maxTokens: 1,
              thinkingLevelMap: { max: "max" },
            },
          ],
        },
        "t",
      ),
    ).toThrowError(/thinkingLevelMap\.max/);
    expect(() =>
      parseCatalogFile(
        {
          version: 1,
          provider: "x",
          models: [
            { id: "a", name: "a", reasoning: false, maxTokens: 1 },
            { id: "a", name: "a", reasoning: false, maxTokens: 1 },
          ],
        },
        "t",
      ),
    ).toThrowError(/duplicated/);
  });

  it("toModel 补 provider / api / input；override 只改元数据并深合并 compat / cost", () => {
    const model = toModel(
      { id: "m", name: "M", reasoning: true, maxTokens: 10 } as never,
      "p",
      "openai-completions",
    );
    expect(model).toMatchObject({ provider: "p", api: "openai-completions", input: ["text"] });
    const withCost = {
      ...model,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: true },
    };
    const next = applyModelOverride(withCost, {
      id: "m",
      contextWindow: 5,
      cost: { input: 9 } as never,
      compat: { maxTokensField: "max_tokens" },
    });
    expect(next.contextWindow).toBe(5);
    expect(next.cost).toEqual({ input: 9, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(next.compat).toEqual({ supportsStore: true, maxTokensField: "max_tokens" });
    expect(next.id).toBe("m");
  });
});
