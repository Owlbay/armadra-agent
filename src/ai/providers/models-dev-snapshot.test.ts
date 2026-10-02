import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODELS_DEV_SOURCES } from "./models-dev-data.js";

const here = dirname(fileURLToPath(import.meta.url));
const snapshotDir = join(here, "models-dev");

function snapshotFiles(): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const ids = readdirSync(snapshotDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
  for (const id of ids)
    out.set(id, JSON.parse(readFileSync(join(snapshotDir, `${id}.json`), "utf8")));
  return out;
}

describe("models.dev 快照数据", () => {
  it("models-dev-data.ts 与 models-dev/*.json 一致", () => {
    const files = snapshotFiles();
    expect(Object.keys(MODELS_DEV_SOURCES).sort()).toEqual([...files.keys()]);
    for (const [id, value] of files)
      expect(JSON.parse(MODELS_DEV_SOURCES[id] ?? "null"), id).toEqual(value);
  });

  it("清单里每家都有快照文件，元数据带 MIT 与来源", () => {
    const list = JSON.parse(MODELS_DEV_SOURCES["_providers"] ?? "{}") as { providers: string[] };
    const files = snapshotFiles();
    expect([...files.keys()].filter((k) => !k.startsWith("_"))).toEqual([...list.providers].sort());
    const meta = JSON.parse(MODELS_DEV_SOURCES["_meta"] ?? "{}") as Record<string, string>;
    expect(meta).toMatchObject({ license: "MIT", upstream: "anomalyco/models.dev" });
    expect(Date.parse(meta["fetchedAt"] ?? "")).not.toBeNaN();
  });

  it("内联数据 ≤ 200 KB（bundle 增量预算，docs/wave5-plan.md §2.4）", () => {
    const bytes = Object.values(MODELS_DEV_SOURCES).reduce(
      (sum, text) => sum + Buffer.byteLength(text),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(200 * 1024);
  });
});
