import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { msg } from "../../i18n/index.js";
import { UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { keyProviders, runAuth } from "./auth.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(tty: boolean, key = "sk-test-key\n") {
  const root = mkdtempSync(join(tmpdir(), "ama-auth-set-"));
  roots.push(root);
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    stdinIsTTY: tty,
    stdoutIsTTY: false,
    env: { AMA_CONFIG_DIR: join(root, "config"), AMA_DATA_DIR: join(root, "data") },
    cwd: root,
    readStdin: async () => key,
  };
  const authFile = join(root, "config", "auth.json");
  const saved = (): Record<string, unknown> =>
    existsSync(authFile)
      ? (JSON.parse(readFileSync(authFile, "utf8")) as { providers: Record<string, unknown> })
          .providers
      : {};
  return { io, out, err, saved };
}

describe("ama auth set 不给 provider（ACP 终端登录方法）", () => {
  it("TTY：选择器列内置的需 key 供应商（不含 OAuth 的 chatgpt 与本地供应商），选中后读 key 保存", async () => {
    const t = harness(true);
    const asked: { question: string; labels: string[] }[] = [];
    const providers = keyProviders();
    const rc = await runAuth(["set"], t.io, {
      chooseProvider: async (question, options) => {
        asked.push({ question, labels: options.map((o) => o.label) });
        return providers.findIndex((p) => p.id === "deepseek");
      },
    });
    expect(rc).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe(msg().auth.pickProvider);
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).not.toContain("chatgpt");
    expect(ids).not.toContain("ollama");
    expect(asked[0]!.labels).toHaveLength(ids.length);
    expect(t.saved()).toHaveProperty("deepseek");
    expect(t.err.join("")).toContain(msg().auth.setPrompt("deepseek"));
  });

  it("TTY 下取消选择：不读 key、不写文件，退出 0", async () => {
    const t = harness(true);
    const rc = await runAuth(["set"], t.io, { chooseProvider: async () => undefined });
    expect(rc).toBe(0);
    expect(t.saved()).toEqual({});
    expect(t.err.join("")).toBe(msg().subcommands.common.cancelled);
  });

  it("非 TTY：仍是用法错误，不弹选择器", async () => {
    const t = harness(false);
    let called = false;
    await expect(
      runAuth(["set"], t.io, {
        chooseProvider: async () => {
          called = true;
          return 0;
        },
      }),
    ).rejects.toThrow(UsageError);
    expect(called).toBe(false);
  });

  it("给了 provider 时照旧，不弹选择器", async () => {
    const t = harness(true);
    const rc = await runAuth(["set", "openai"], t.io, {
      chooseProvider: async () => {
        throw new Error("should not ask");
      },
    });
    expect(rc).toBe(0);
    expect(t.saved()).toHaveProperty("openai");
  });
});
