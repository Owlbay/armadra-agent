import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MODELS_DEV_SOURCES } from "./models-dev-data.js";
import {
  buildSnapshot,
  builtinSnapshot,
  diffSnapshots,
  mergeSnapshot,
  toSnapshotFile,
  type SnapshotList,
} from "./models-dev-snapshot.js";

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

describe("buildSnapshot 与脚本同一口径", () => {
  it("同一 fixture：脚本写出的每家 JSON = buildSnapshot() 的文件形状", () => {
    const fixtures = join(process.cwd(), "test", "fixtures", "models-dev");
    const listPath = join(fixtures, "snapshot-providers.json");
    const apiPath = join(fixtures, "snapshot-api.json");
    const out = join(mkdtempSync(join(tmpdir(), "ama-mdev-parity-")), "models-dev");
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "scripts", "update-models-dev.mjs"),
          ...["--input", apiPath, "--out", out, "--list", listPath, "--min-providers", "1"],
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const list = JSON.parse(readFileSync(listPath, "utf8")) as SnapshotList;
      const built = buildSnapshot(JSON.parse(readFileSync(apiPath, "utf8")), list);
      for (const id of list.providers) {
        const written = JSON.parse(readFileSync(join(out, `${id}.json`), "utf8"));
        expect(toSnapshotFile(built[id]!), id).toEqual(written);
      }
    } finally {
      rmSync(dirname(out), { recursive: true, force: true });
    }
  });

  it("内置快照重新裁剪一遍不变（数据本身满足过滤规则）", () => {
    const raw: Record<string, unknown> = {};
    for (const provider of Object.values(builtinSnapshot()))
      raw[provider.id] = toSnapshotFile(provider);
    expect(buildSnapshot(raw)).toEqual(builtinSnapshot());
  });

  it("mergeSnapshot 按模型合并；diffSnapshots 只比较新数据里的供应商", () => {
    const base = {
      a: { id: "a", models: { x: { id: "x", limit: { context: 1 } }, y: { id: "y" } } },
      b: { id: "b", models: { z: { id: "z" } } },
    };
    const next = {
      a: { id: "a", models: { x: { id: "x", limit: { context: 2 } }, w: { id: "w" } } },
    };
    const merged = mergeSnapshot(base, next);
    expect(Object.keys(merged["a"]!.models).sort()).toEqual(["w", "x", "y"]);
    expect(merged["a"]!.models["x"]!.limit?.context).toBe(2);
    expect(merged["b"]).toBe(base.b);
    expect(diffSnapshots(base, next)).toEqual({
      added: ["a/w"],
      removed: ["a/y"],
      changed: ["a/x：context 1 → 2"],
    });
  });
});
