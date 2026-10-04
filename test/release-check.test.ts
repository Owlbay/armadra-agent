/**
 * `scripts/release-check.mjs`（第三波 §2.4）：版本规则的正反例 + 临时 git 仓库里的 CLI 行为。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
interface DocsInput {
  version: string;
  docs: Record<string, string | undefined>;
  packageFiles: string[];
}
interface ReleaseCheckModule {
  checkRelease(input: CheckInput): { ok: boolean; errors: string[]; notes: string[] };
  readConstant(source: string, name: string): number | undefined;
  checkDocs(input: DocsInput): { errors: string[]; notes: string[] };
  hasVersionSection(text: string, version: string): boolean;
  filesEntryCovers(entry: string, path: string): boolean;
  DOC_FILES: string[];
  PACKED_DOC_FILES: string[];
  translationBasis(text: string | undefined): string | undefined;
  staleTranslations(
    docs: { name: string; basis: string | undefined; commits: number | undefined }[],
    threshold?: number,
  ): string[];
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

const EN_DOCS = ["tui", "permissions", "providers", "rpc", "host-api", "sessions", "acp"];
const PACKAGE_FILES = ["docs/en/*.md", "README.zh-CN.md", "CHANGELOG.md", "CHANGELOG.zh-CN.md"];

/** 合格的双语文档（CHANGELOG 两份都有该版本段）。 */
function docFixture(version: string): Record<string, string> {
  return {
    "README.md": "# ama\n\nEnglish · [简体中文](README.zh-CN.md)\n",
    "README.zh-CN.md": "# ama\n\n[English](README.md) · 简体中文\n",
    "CHANGELOG.md": `# Changelog\n\nEnglish · [简体中文](CHANGELOG.zh-CN.md)\n\n## ${version} (2026-10-10)\n`,
    "CHANGELOG.zh-CN.md": `# 更新记录\n\n[English](CHANGELOG.md) · 简体中文\n\n## ${version}（2026-10-10）\n`,
    ...Object.fromEntries(EN_DOCS.map((name) => [`docs/en/${name}.md`, `# ${name}\n`])),
  };
}

describe("release-check 双语文档（第六波 §5.5）", () => {
  it("合格的文档通过；本仓库当前的文档与 package.json 通过", async () => {
    const { checkDocs, DOC_FILES } = await load();
    expect(DOC_FILES).toEqual(Object.keys(docFixture("0.6.0")));
    expect(
      checkDocs({ version: "0.6.0", docs: docFixture("0.6.0"), packageFiles: PACKAGE_FILES })
        .errors,
    ).toEqual([]);
    const root = join(dirname(SCRIPT), "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
      files: string[];
    };
    const docs = Object.fromEntries(
      DOC_FILES.map((file) => [
        file,
        existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : undefined,
      ]),
    );
    expect(checkDocs({ version: pkg.version, docs, packageFiles: pkg.files }).errors).toEqual([]);
  });

  it("0.6.0 前只查中文 CHANGELOG 的版本段；之后两份都查；「未发布」不算", async () => {
    const { checkDocs } = await load();
    const docs = docFixture("0.5.1");
    docs["CHANGELOG.md"] =
      "# Changelog\n\nEnglish · [简体中文](CHANGELOG.zh-CN.md)\n\n## Unreleased\n";
    const before = checkDocs({ version: "0.5.1", docs, packageFiles: PACKAGE_FILES });
    expect(before.errors).toEqual([]);
    expect(before.notes.join("\n")).toContain("只查中文");
    const after = checkDocs({
      version: "0.6.0",
      docs: { ...docFixture("0.6.0"), "CHANGELOG.md": docs["CHANGELOG.md"] },
      packageFiles: PACKAGE_FILES,
    });
    expect(after.errors).toEqual(["CHANGELOG.md 没有 0.6.0 的段"]);
    const zhMissing = checkDocs({
      version: "0.6.0",
      docs: {
        ...docFixture("0.6.0"),
        "CHANGELOG.zh-CN.md": "[English](CHANGELOG.md)\n## 未发布\n",
      },
      packageFiles: PACKAGE_FILES,
    });
    expect(zhMissing.errors).toEqual(["CHANGELOG.zh-CN.md 没有 0.6.0 的段"]);
  });

  it("缺文件、files 漏列、顶部没有互链 → 报错", async () => {
    const { checkDocs } = await load();
    const docs: Record<string, string | undefined> = docFixture("0.6.0");
    docs["docs/en/rpc.md"] = undefined;
    docs["README.zh-CN.md"] = "# ama\n";
    const result = checkDocs({
      version: "0.6.0",
      docs,
      packageFiles: ["README.zh-CN.md", "CHANGELOG.md"],
    });
    expect(result.errors).toEqual([
      "缺少 docs/en/rpc.md",
      "package.json files 没有包含 CHANGELOG.zh-CN.md",
      ...EN_DOCS.map((name) => `package.json files 没有包含 docs/en/${name}.md`),
      "README.zh-CN.md 顶部缺少到 README.md 的链接",
    ]);
  });

  it("版本段与 files 匹配规则", async () => {
    const { hasVersionSection, filesEntryCovers } = await load();
    expect(hasVersionSection("## 0.6.0（2026-10-10）", "0.6.0")).toBe(true);
    expect(hasVersionSection("x\n## 0.6.0 (2026-10-10)\n", "0.6.0")).toBe(true);
    expect(hasVersionSection("## v0.6.0\n", "0.6.0")).toBe(true);
    expect(hasVersionSection("## 0.6.0-rc.1\n", "0.6.0")).toBe(false);
    expect(hasVersionSection("## 0.6.01\n", "0.6.0")).toBe(false);
    expect(hasVersionSection("### 0.6.0\n", "0.6.0")).toBe(false);
    expect(filesEntryCovers("docs/en/*.md", "docs/en/rpc.md")).toBe(true);
    expect(filesEntryCovers("docs/en", "docs/en/rpc.md")).toBe(true);
    expect(filesEntryCovers("./docs/en/", "docs/en/rpc.md")).toBe(true);
    expect(filesEntryCovers("docs/*.md", "docs/en/rpc.md")).toBe(false);
    expect(filesEntryCovers("docs/**", "docs/en/rpc.md")).toBe(true);
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
    put("package.json", JSON.stringify({ version, files: PACKAGE_FILES }));
    for (const [file, text] of Object.entries(docFixture(version))) put(file, text);
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

describe("英文文档滞后提示（[W6-I5]，§5.5）", () => {
  it("读头部基准提交；超过阈值才提示，看不到基准时跳过", async () => {
    const m = await load();
    expect(m.translationBasis("> Translated … as of commit `ee89edb`. When …")).toBe("ee89edb");
    expect(m.translationBasis("# no header")).toBeUndefined();
    const notes = m.staleTranslations(
      [
        { name: "tui", basis: "ed2c792", commits: 8 },
        { name: "rpc", basis: "ee89edb", commits: 5 },
        { name: "sessions", basis: "ee89edb", commits: undefined },
        { name: "host-api", basis: undefined, commits: 99 },
      ],
      5,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("docs/tui.md");
    expect(notes[0]).toContain("ed2c792");
  });
});
