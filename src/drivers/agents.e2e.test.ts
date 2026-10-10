/**
 * 真实外部 CLI 的端到端（docs/history/wave5-plan.md §5.7、§14 第 3 条）：只在本地、`AMA_E2E_AGENTS=1` 时跑，
 * CI 永不设置。需要用户已登录的 `claude` / `codex`——**会使用你的订阅额度**（每家约 3 个小请求）。
 *
 *   AMA_E2E_AGENTS=1 pnpm vitest run src/drivers/agents.e2e.test.ts
 *
 * 每家：临时目录里两轮「只回 OK」+ 一次触发审批的写文件（测试代替人点「允许」）；
 * Claude 跑前后比对 `~/.claude` 下 settings*.json 的字节指纹（不得被改写）；
 * Codex 另外用本机 `generate-json-schema` 重新抽取形状，与 `test/fixtures/drivers/codex-schema/shapes.json` 比对。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../permissions/types.js";
import { ExternalAgents } from "./agents.js";

const enabled = process.env["AMA_E2E_AGENTS"] === "1";
const dir = enabled ? realpathSync(mkdtempSync(join(tmpdir(), "ama-e2e-agents-"))) : "";
afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

function fingerprint(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(root))
    if (/^settings.*\.json$/.test(name))
      out[name] = createHash("sha256")
        .update(readFileSync(join(root, name)))
        .digest("hex");
  return out;
}

async function roundTrip(spec: string) {
  const asked: ApprovalRequest[] = [];
  const agents = new ExternalAgents({
    env: process.env,
    cwd: dir,
    hosted: false,
    trusted: () => true,
    approve: async (req) => {
      asked.push(req);
      return "allow";
    },
  });
  const runner = agents.resolve(spec);
  const handle = await runner.start({
    prompt: "Reply with exactly OK and nothing else.",
    cwd: dir,
    mode: "default",
    signal: new AbortController().signal,
    onEvent: () => undefined,
  });
  const first = await handle.wait();
  await handle.send("Reply with exactly OK again.");
  const second = await handle.wait();
  await handle.send(
    `Create a file named note-${spec}.txt in the current directory containing the word hi.`,
  );
  const third = await handle.wait();
  await handle.stop();
  return { first, second, third, asked };
}

describe.skipIf(!enabled)("真实外部 CLI（本地）", () => {
  it("claude：两轮 + 一次审批写文件；~/.claude 设置不被改写", async () => {
    const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
    const before = fingerprint(configDir);
    const r = await roundTrip("claude");
    expect(r.first.text).toMatch(/OK/);
    expect(r.second.text).toMatch(/OK/);
    expect(r.asked.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "note-claude.txt"))).toBe(true);
    expect(fingerprint(configDir)).toEqual(before);
  }, 300_000);

  it("codex：两轮 + 一次审批写文件", async () => {
    const r = await roundTrip("codex");
    expect(r.first.text).toMatch(/OK/);
    expect(r.second.text).toMatch(/OK/);
    expect(r.asked.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "note-codex.txt"))).toBe(true);
  }, 300_000);

  it("codex schema 形状与黄金文件一致", () => {
    const out = join(dir, "schema");
    execFileSync("codex", ["app-server", "generate-json-schema", "--out", out]);
    const extract = fileURLToPath(
      new URL("../../test/fixtures/drivers/codex-schema/extract.mjs", import.meta.url),
    );
    const fresh = join(dir, "shapes.json");
    execFileSync(process.execPath, [extract, out, fresh]);
    const strip = (file: string) => {
      const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      delete json["source"];
      return json;
    };
    const golden = fileURLToPath(
      new URL("../../test/fixtures/drivers/codex-schema/shapes.json", import.meta.url),
    );
    expect(strip(fresh)).toEqual(strip(golden));
  });
});
