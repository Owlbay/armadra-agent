import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo } from "../../cli/deps.js";
import { runAuth } from "../../cli/subcommands/auth.js";
import { readOAuthEntry } from "../oauth/token-store.js";
import { FakeOAuthServer, followAuthorize } from "../testing/fake-oauth.js";

let server: FakeOAuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

interface Harness {
  io: CliIo;
  out: string[];
  err: string[];
  authFile: string;
  stdin: string[];
  deps: Parameters<typeof runAuth>[2];
}

async function harness(tty = false): Promise<Harness> {
  server = new FakeOAuthServer({ marker: "SECRETMARK" });
  const issuer = await server.start();
  const root = mkdtempSync(join(tmpdir(), "ama-cli-"));
  const out: string[] = [];
  const err: string[] = [];
  const stdin: string[] = [];
  const io: CliIo = {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    stdinIsTTY: tty,
    stdoutIsTTY: false,
    env: {
      AMA_CONFIG_DIR: join(root, "config"),
      AMA_DATA_DIR: join(root, "data"),
      AMA_CHATGPT_ISSUER: issuer,
      AMA_CHATGPT_BASE_URL: `${issuer}/codex`,
    },
    cwd: root,
    readStdin: async () => stdin.shift() ?? "",
  };
  return {
    io,
    out,
    err,
    stdin,
    authFile: join(root, "config", "auth.json"),
    deps: {
      openBrowser: async (url) => {
        void followAuthorize(url);
        return true;
      },
    },
  };
}

function all(h: Harness): string {
  return h.out.join("") + h.err.join("");
}

describe("ama auth login / status / logout chatgpt", () => {
  it("缺省 siwc：浏览器登录写 0600 条目；输出只有掩码邮箱，不含 token / code", async () => {
    const h = await harness();
    const rc = await runAuth(["login", "chatgpt", "--port", "0"], h.io, h.deps);
    expect(rc).toBe(0);
    const entry = readOAuthEntry(h.authFile, "chatgpt");
    expect(entry).toMatchObject({ flavor: "siwc", clientId: "oaiapp_issued", planType: "plus" });
    if (process.platform !== "win32") expect(statSync(h.authFile).mode & 0o777).toBe(0o600);
    const text = all(h);
    expect(text).toContain("已登录 ChatGPT（siwc · plus · a***@example.com）");
    expect(text).toContain("App limits");
    expect(text).not.toContain("alice@");
    expect(text).not.toContain("SECRETMARK");
    expect(text).not.toContain("code-");

    h.out.length = 0;
    expect(await runAuth(["status"], h.io, h.deps)).toBe(0);
    expect(h.out.join("")).toMatch(
      /chatgpt {2}siwc · plus · a\*\*\*@example\.com\n {2}access token 还剩 (59|60)m/,
    );
    expect(h.out.join("")).toContain("配额：只在超限时可知");

    h.out.length = 0;
    expect(await runAuth(["list"], h.io, h.deps)).toBe(0);
    expect(h.out.join("")).toMatch(/chatgpt\s+oauth · siwc · plus/);

    h.out.length = 0;
    expect(await runAuth(["logout", "chatgpt"], h.io, h.deps)).toBe(0);
    expect(h.out.join("")).toContain("token 已撤销");
    expect(server?.revoked).toHaveLength(1);
    expect(readOAuthEntry(h.authFile, "chatgpt")).toBeUndefined();
    expect(await runAuth(["logout", "chatgpt"], h.io, h.deps)).toBe(1);
    expect(all(h)).not.toContain("SECRETMARK");
  });

  it("codex：非 TTY 无 --yes 拒绝；--yes 记 acknowledgedAt；再次登录不再确认；status 显示配额", async () => {
    const h = await harness();
    expect(await runAuth(["login", "chatgpt", "--flavor", "codex"], h.io, h.deps)).toBe(2);
    expect(h.err.join("")).toContain("非官方用法");
    expect(h.err.join("")).toContain("--yes");
    expect(
      await runAuth(
        ["login", "chatgpt", "--flavor", "codex", "--yes", "--port", "0"],
        h.io,
        h.deps,
      ),
    ).toBe(0);
    const first = readOAuthEntry(h.authFile, "chatgpt");
    expect(first?.acknowledgedAt).toMatch(/^\d{4}-/);
    h.err.length = 0;
    expect(
      await runAuth(["login", "chatgpt", "--flavor", "codex", "--port", "0"], h.io, h.deps),
    ).toBe(0);
    expect(h.err.join("")).not.toContain("非官方用法");
    expect(readOAuthEntry(h.authFile, "chatgpt")?.acknowledgedAt).toBe(first?.acknowledgedAt);

    server?.responses.push({
      body: {
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1 },
          secondary_window: { used_percent: 18, limit_window_seconds: 604800 },
        },
      },
    });
    h.out.length = 0;
    expect(await runAuth(["status", "chatgpt"], h.io, h.deps)).toBe(0);
    expect(h.out.join("")).toMatch(/配额：5 小时 42%（[\d:\- ]+ 重置） · 周 18%/);
    const usage = server?.requests.find((r) => r.path === "/wham/usage");
    expect(usage?.headers["chatgpt-account-id"]).toBe("acct-1");
    h.out.length = 0;
    expect(await runAuth(["logout", "chatgpt"], h.io, h.deps)).toBe(0);
    expect(h.out.join("")).toContain("已从");
    expect(server?.revoked).toHaveLength(0);
    expect(all(h)).not.toContain("SECRETMARK");
  });

  it("授权被拒（access_denied）：列出可能原因与下一步；siwc 提示备用 --flavor codex，codex 不提示", async () => {
    const h = await harness();
    const deny = {
      openBrowser: async (url: string) => {
        const u = new URL(url);
        const back = `${u.searchParams.get("redirect_uri")}?error=access_denied&state=${u.searchParams.get("state")}`;
        void fetch(back).catch(() => undefined);
        return true;
      },
    };
    expect(await runAuth(["login", "chatgpt", "--port", "0"], h.io, deny)).toBe(1);
    const text = h.err.join("");
    expect(text).toContain("授权未通过（access_denied）。可能的原因：");
    expect(text).toContain("重新运行 ama auth login chatgpt 并确认勾选");
    expect(text).toContain("Team / Enterprise");
    expect(text).toContain("所在地区受限");
    expect(text).toContain("ama auth login chatgpt --flavor codex");
    expect(readOAuthEntry(h.authFile, "chatgpt")).toBeUndefined();
    h.err.length = 0;
    expect(
      await runAuth(["login", "chatgpt", "--flavor", "codex", "--yes", "--port", "0"], h.io, deny),
    ).toBe(1);
    expect(h.err.join("")).toContain("所在地区受限");
    expect(h.err.join("")).not.toContain("改用备用方式");
  });

  it("授权被拒的提示（en）", async () => {
    const { setLocale } = await import("../../i18n/index.js");
    setLocale("en");
    try {
      const { loginErrorText } = await import("./cli.js");
      const { AmaError } = await import("../../errors.js");
      const text = loginErrorText(
        new AmaError("oauth_denied", "x", { detail: { error: "access_denied" } }),
        "siwc",
      );
      expect(text).toContain("sign-in was not authorized (access_denied). Possible causes:");
      expect(text).toContain("Your region is not supported");
      expect(text).toContain("ama auth login chatgpt --flavor codex");
    } finally {
      setLocale("zh");
    }
  });

  it("TTY 确认：回答 n 取消", async () => {
    const h = await harness(true);
    h.stdin.push("n");
    expect(await runAuth(["login", "chatgpt", "--flavor", "codex"], h.io, h.deps)).toBe(1);
    expect(h.err.join("")).toContain("已取消");
  });

  it("--paste：读回调 URL；state 不符报错", async () => {
    const h = await harness();
    let url = "";
    const deps = {
      readLine: async () => {
        const res = await fetch(url, { redirect: "manual" });
        return res.headers.get("location") ?? "";
      },
    };
    const io = {
      ...h.io,
      stderr: (t: string) =>
        void ((url = /(http\S+authorize\S+)/.exec(t)?.[1] ?? url), h.err.push(t)),
    };
    expect(await runAuth(["login", "chatgpt", "--paste"], io, deps)).toBe(0);
    expect(h.err.join("")).toContain("粘贴到这里");
    const bad = { readLine: async () => "http://127.0.0.1:1455/auth/callback?code=x&state=nope" };
    expect(await runAuth(["login", "chatgpt", "--paste"], h.io, bad)).toBe(1);
    expect(h.err.join("")).toContain("state 不符");
  });

  it("用法错误：--device 需 codex；非 chatgpt；--flavor 非法；login 选项用在别的动作", async () => {
    const h = await harness();
    await expect(runAuth(["login", "chatgpt", "--device"], h.io)).rejects.toThrow(/--flavor codex/);
    await expect(runAuth(["login", "openai"], h.io)).rejects.toThrow(/只支持 chatgpt/);
    await expect(runAuth(["login", "chatgpt", "--flavor", "x"], h.io)).rejects.toThrow(
      /siwc 或 codex/,
    );
    await expect(runAuth(["list", "--yes"], h.io)).rejects.toThrow(/--yes/);
    expect(await runAuth(["status"], h.io)).toBe(0);
    expect(h.out.join("")).toContain("没有 OAuth 登录");
  });

  it("配置 auth.chatgpt.flavor 决定缺省 flavor", async () => {
    const h = await harness();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(h.io.env["AMA_CONFIG_DIR"] ?? "", { recursive: true });
    writeFileSync(
      join(h.io.env["AMA_CONFIG_DIR"] ?? "", "config.json"),
      JSON.stringify({ version: 1, auth: { chatgpt: { flavor: "codex" } } }),
    );
    expect(await runAuth(["login", "chatgpt", "--yes", "--port", "0"], h.io, h.deps)).toBe(0);
    expect(JSON.parse(readFileSync(h.authFile, "utf8")).providers.chatgpt.flavor).toBe("codex");
  });
});
