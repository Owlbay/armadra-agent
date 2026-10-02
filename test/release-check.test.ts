/**
 * `scripts/release-check.mjs`（第三波 §2.4）：版本规则的正反例 + 临时 git 仓库里的 CLI 行为。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface Previous {
  tag: string;
  version: string;
  constants: Record<string, number | undefined>;
}
interface CheckInput {
  version: string;
  constants: Record<string, number | undefined>;
  previous?: Previous;
  refTag?: string;
}
interface ReleaseCheckModule {
  checkRelease(input: CheckInput): { ok: boolean; errors: string[]; notes: string[] };
  readConstant(source: string, name: string): number | undefined;
}

const SCRIPT = fileURLToPath(new URL("../scripts/release-check.mjs", import.meta.url));
const load = (): Promise<ReleaseCheckModule> =>
  import(pathToFileURL(SCRIPT).href) as Promise<ReleaseCheckModule>;

const V1 = { HOST_API_VERSION: 1, RPC_PROTOCOL_VERSION: 1, SESSION_FORMAT_VERSION: 1 };
const prev = (version: string, constants: Record<string, number> = V1): Previous => ({
  tag: `v${version}`,
  version,
  constants,
});

describe("release-check 规则", () => {
  it("正例：无 tag；补丁版本；协议不变；协议变化随主版本 / 0.x 次版本升级", async () => {
    const { checkRelease } = await load();
    expect(checkRelease({ version: "0.1.0", constants: V1 }).ok).toBe(true);
    expect(checkRelease({ version: "0.1.0", constants: V1, previous: prev("0.1.0") }).ok).toBe(
      true,
    );
    expect(checkRelease({ version: "1.2.4", constants: V1, previous: prev("1.2.3") }).ok).toBe(
      true,
    );
    const rpc2 = { ...V1, RPC_PROTOCOL_VERSION: 2 };
    expect(checkRelease({ version: "2.0.0", constants: rpc2, previous: prev("1.4.0") }).ok).toBe(
      true,
    );
    const r = checkRelease({ version: "0.2.0", constants: rpc2, previous: prev("0.1.3") });
    expect(r.ok).toBe(true);
    expect(r.notes.join("\n")).toContain("RPC_PROTOCOL_VERSION 1 → 2");
    expect(
      checkRelease({ version: "0.2.0", constants: V1, previous: prev("0.1.0"), refTag: "v0.2.0" })
        .ok,
    ).toBe(true);
  });

  it("反例：协议变化只升次 / 补丁版本；版本回退；格式错误；tag 与版本不符；常量缺失", async () => {
    const { checkRelease } = await load();
    const host2 = { ...V1, HOST_API_VERSION: 2 };
    const minor = checkRelease({ version: "1.5.0", constants: host2, previous: prev("1.4.0") });
    expect(minor.ok).toBe(false);
    expect(minor.errors[0]).toMatch(/HOST_API_VERSION 1 → 2.*需要升主版本号/);
    const patch0 = checkRelease({
      version: "0.1.4",
      constants: { ...V1, SESSION_FORMAT_VERSION: 2 },
      previous: prev("0.1.3"),
    });
    expect(patch0.errors[0]).toMatch(/需要升次版本号（0\.x）/);
    expect(
      checkRelease({ version: "0.1.0", constants: V1, previous: prev("0.2.0") }).errors,
    ).toEqual(["版本 0.1.0 低于上一个 tag v0.2.0"]);
    expect(checkRelease({ version: "1.0", constants: V1 }).ok).toBe(false);
    expect(
      checkRelease({ version: "0.2.0", constants: V1, refTag: "v0.2.1" }).errors.join(""),
    ).toContain("不一致");
    expect(
      checkRelease({ version: "0.2.0", constants: { ...V1, RPC_PROTOCOL_VERSION: undefined } })
        .errors,
    ).toEqual(["源码里找不到 RPC_PROTOCOL_VERSION"]);
  });

  it("readConstant 认 `as const` 写法；本仓库三个常量都读得到", async () => {
    const { readConstant } = await load();
    expect(
      readConstant("export const RPC_PROTOCOL_VERSION = 3 as const;", "RPC_PROTOCOL_VERSION"),
    ).toBe(3);
    expect(readConstant("const X = 1", "RPC_PROTOCOL_VERSION")).toBeUndefined();
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("release-check: ok");
  });
});

describe("release-check CLI（临时 git 仓库）", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function repo(): (args: string[]) => string {
    root = mkdtempSync(join(tmpdir(), "ama-release-check-"));
    const dir = root;
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    git(["init", "-q"]);
    return git;
  }

  function write(version: string, rpc: number): void {
    const dir = root as string;
    const put = (file: string, text: string): void => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    };
    put("package.json", JSON.stringify({ version }));
    put("src/host/types.ts", "export const HOST_API_VERSION = 1 as const;\n");
    put("src/rpc.ts", `export const RPC_PROTOCOL_VERSION = ${rpc} as const;\n`);
    put("src/session/types.ts", "export const SESSION_FORMAT_VERSION = 1 as const;\n");
  }

  const run = (env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT, "--root", root as string], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF_TYPE: "", ...env },
    });

  it("相对上一个 tag：协议变了未升版本 → 退出 1；升到 0.2.0 → 0；tag 构建比较它之前的 tag", () => {
    const git = repo();
    write("0.1.0", 1);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    git(["tag", "v0.1.0"]);
    write("0.1.1", 2);
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("RPC_PROTOCOL_VERSION 1 → 2");
    write("0.2.0", 2);
    expect(run().status).toBe(0);
    git(["commit", "-qam", "bump"]);
    git(["tag", "v0.2.0"]);
    const tagged = run({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.2.0" });
    expect(tagged.status).toBe(0);
    expect(tagged.stdout).toContain("相对 v0.1.0：版本 0.1.0 → 0.2.0");
    expect(run({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.3.0" }).status).toBe(1);
  });
});
