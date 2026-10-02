import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const script = join(root, "scripts", "update-models-dev.mjs");
const fixture = join(root, "test", "fixtures", "models-dev", "snapshot-api.json");
const list = join(root, "test", "fixtures", "models-dev", "snapshot-providers.json");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ama-models-dev-"));
  dirs.push(dir);
  return dir;
}

function run(out: string, input: string, ...extra: string[]) {
  const result = spawnSync(
    process.execPath,
    [script, "--input", input, "--out", out, "--list", list, "--min-providers", "1", ...extra],
    { encoding: "utf8" },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function snapshotBytes(out: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(out).sort()) files[name] = readFileSync(join(out, name), "utf8");
  files["data"] = readFileSync(join(out, "..", "models-dev-data.ts"), "utf8");
  return files;
}

describe("scripts/update-models-dev.mjs", () => {
  it("按清单裁剪过滤、规范化写出，摘要列新增", () => {
    const out = join(tmp(), "models-dev");
    const first = run(out, fixture, "--now", "2026-10-02T00:00:00.000Z");
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "_meta.json",
      "anthropic.json",
      "google.json",
      "openai.json",
      "openrouter.json",
    ]);
    const anthropic = JSON.parse(readFileSync(join(out, "anthropic.json"), "utf8"));
    expect(Object.keys(anthropic.models)).toEqual(["claude-haiku-4-5", "claude-opus-5-5"]);
    expect(anthropic.models["claude-opus-5-5"]).toEqual({
      canonical_model_id: "anthropic/claude-opus-5-5",
      cost: { cache_read: 0.2, cache_write: 5, input: 4, output: 20 },
      family: "claude-opus",
      knowledge: "2026-06",
      limit: { context: 1000000, output: 128000 },
      modalities: { input: ["text", "image", "pdf"] },
      name: "Claude Opus 5.5",
      reasoning: true,
      release_date: "2026-09-22",
    });
    const openai = JSON.parse(readFileSync(join(out, "openai.json"), "utf8"));
    // deprecated / 只出图 / tool_call:false / context 0 都被过滤
    expect(Object.keys(openai.models)).toEqual(["beta-one", "gpt-5.4-mini", "gpt-6.1-sol"]);
    expect(openai.models["beta-one"]).toMatchObject({
      status: "beta",
      interleaved: { field: "reasoning_content" },
      limit: { context: 200000, input: 150000, output: 32000 },
      cost: { context_over_200k: { input: 2, output: 4 } },
    });
    expect(openai.models["gpt-6.1-sol"].cost.tiers).toEqual([
      {
        cache_read: 0.2,
        cache_write: 5,
        input: 4,
        output: 15,
        tier: { size: 272000, type: "context" },
      },
    ]);
    const openrouter = JSON.parse(readFileSync(join(out, "openrouter.json"), "utf8"));
    expect(Object.keys(openrouter.models)).toEqual(["anthropic/claude-opus-5.5", "openai/gpt-5.5"]);
    const meta = JSON.parse(readFileSync(join(out, "_meta.json"), "utf8"));
    expect(meta).toMatchObject({
      fetchedAt: "2026-10-02T00:00:00.000Z",
      license: "MIT",
      source: "https://models.dev/api.json",
      upstream: "anomalyco/models.dev",
    });
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(out, "openai.json"), "utf8")).toMatch(/^\{\n {2}"id": "openai",\n/);
    expect(first.stdout).toContain("新增 8、删除 0");
    expect(first.stdout).toContain("- openai/beta-one");
  });

  it("再跑一次字节不变（fetchedAt 只随 sha256 变化），摘要为无变化", () => {
    const out = join(tmp(), "models-dev");
    run(out, fixture, "--now", "2026-10-02T00:00:00.000Z");
    const before = snapshotBytes(out);
    const again = run(out, fixture, "--now", "2030-01-01T00:00:00.000Z");
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("无变化");
    expect(snapshotBytes(out)).toEqual(before);
  });

  it("变价与删除进摘要；删除超过 30% 退出码 3 且照写", () => {
    const out = join(tmp(), "models-dev");
    run(out, fixture, "--now", "2026-10-02T00:00:00.000Z");
    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    raw.anthropic.models["claude-opus-5-5"].cost.input = 3;
    const changed = join(tmp(), "api.json");
    writeFileSync(changed, JSON.stringify(raw));
    const priced = run(out, changed, "--now", "2026-10-09T00:00:00.000Z");
    expect(priced.code).toBe(0);
    expect(priced.stdout).toContain("anthropic/claude-opus-5-5：cost 4/20/0.2/5 → 3/20/0.2/5");
    expect(JSON.parse(readFileSync(join(out, "_meta.json"), "utf8")).fetchedAt).toBe(
      "2026-10-09T00:00:00.000Z",
    );
    delete raw.openai.models["gpt-6.1-sol"];
    delete raw.openai.models["gpt-5.4-mini"];
    delete raw.openai.models["beta-one"];
    delete raw.anthropic.models["claude-haiku-4-5"];
    // openai 删光会被「过滤后没有模型」拦下：留一个改过的
    raw.openai.models["beta-one"] = { tool_call: true, limit: { context: 1000 } };
    writeFileSync(changed, JSON.stringify(raw));
    const removed = run(out, changed, "--now", "2026-10-16T00:00:00.000Z");
    expect(removed.code).toBe(3);
    expect(removed.stdout).toContain("- openai/gpt-6.1-sol");
    expect(JSON.parse(readFileSync(join(out, "openai.json"), "utf8")).models).toEqual({
      "beta-one": { limit: { context: 1000 } },
    });
  });

  it("校验失败退出码 1 且不写文件；--dry-run 不写", () => {
    const out = join(tmp(), "models-dev");
    const few = run(out, fixture, "--min-providers", "100");
    expect(few.code).toBe(1);
    expect(few.stderr).toContain("家供应商");
    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    delete raw.google;
    const missing = join(tmp(), "api.json");
    writeFileSync(missing, JSON.stringify(raw));
    expect(run(out, missing).stderr).toContain("缺少供应商 google");
    const dry = run(out, fixture, "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("新增 8");
    expect(() => readdirSync(out)).toThrow();
  });
});
