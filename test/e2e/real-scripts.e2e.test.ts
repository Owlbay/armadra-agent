/**
 * 真实模型脚本的管线（第三波 §2.4 / §3.7）：`bench-presets.mjs` 与 `cache-experiment.mjs` 用 fake
 * 供应商跑一遍——不花钱、不联网，只验证计数、超限中止与报告输出。需要构建产物 `dist/`。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";

const script = (name: string): string =>
  fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
const hasDist = existsSync(fileURLToPath(new URL("../../dist/index.js", import.meta.url)));

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function run(name: string, args: string[]) {
  home ??= createTmpHome("ama-real-scripts-");
  return spawnSync(process.execPath, [script(name), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...home.env,
      AMA_NO_LOCAL_PROBE: "1",
      AMA_REAL_CONFIG: home.path("missing.json"),
    },
  });
}

describe.skipIf(!hasDist)("e2e：真实模型脚本的管线（fake 供应商）", () => {
  it("bench-presets：请求上限 2 → 跑完 2 组后提前停止，报告含三张表", () => {
    const r = run("bench-presets.mjs", [
      "--models",
      "fake/echo",
      "--tasks",
      "fix-bug",
      "--max-requests",
      "2",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("## 按预设 × 任务");
    expect(r.stdout).toContain("**提前停止：请求数达到上限 2**");
    const rows = r.stdout.split("\n").filter((l) => l.startsWith("| fake/echo |"));
    expect(rows).toHaveLength(2);
    expect(r.stderr).toMatch(/✗ fake\/echo default fix-bug · 1 轮/);
  });

  it("cache-experiment：E1 / E4 / E5 结果累积进 JSON，--render 出报告", () => {
    home = createTmpHome("ama-real-scripts-");
    const json = home.path("cache.json");
    const r = run("cache-experiment.mjs", [
      "--case",
      "E1,E4,E5",
      "--models",
      "fake/echo",
      "--switch-to",
      "fake/reasoning",
      "--max-requests",
      "30",
      "--json",
      json,
    ]);
    expect(r.status, r.stderr).toBe(0);
    const data = JSON.parse(readFileSync(json, "utf8")) as {
      runs: { case: string; requests: unknown[]; probe?: { verdict: string } }[];
    };
    expect(data.runs.map((x) => x.case)).toEqual(["E1", "E4", "E5"]);
    expect(data.runs[0]?.requests).toHaveLength(5);
    expect(data.runs[2]?.probe?.verdict).toBe("silent");
    const report = run("cache-experiment.mjs", ["--render", json]);
    expect(report.stdout).toContain("## E1 基线命中率");
    expect(report.stdout).toContain("| 宿主注册 canvas_note | 无 |");
    expect(report.stdout).toContain("## E5 不报缓存的端点");
  });
});
