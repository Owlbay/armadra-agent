/**
 * 记忆路径（docs/wave6-plan.md §3.2、D9）：逻辑路径安全全表、项目根与分桶。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryPathError,
  assertNoSymlink,
  parseMemoryPath,
  projectBucket,
  projectRootOf,
  standaloneRoots,
} from "./paths.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  // native：与 projectRootOf 一致（Windows 上展开 8.3 短名）
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "ama-mem-paths-")));
  dirs.push(d);
  return d;
}

const roots = { user: join("/data", "memory", "user"), project: join("/data", "memory", "p") };

describe("逻辑路径", () => {
  it("根、作用域目录、子目录与文件", () => {
    expect(parseMemoryPath("/memories", roots)).toEqual({ kind: "root" });
    expect(parseMemoryPath("/memories/", roots)).toEqual({ kind: "root" });
    expect(parseMemoryPath("/memories/user", roots)).toMatchObject({
      kind: "dir",
      scope: "user",
      file: "",
      abs: roots.user,
    });
    expect(parseMemoryPath("/memories/project/a/b.md", roots)).toMatchObject({
      kind: "file",
      scope: "project",
      file: "a/b.md",
      abs: join(roots.project, "a", "b.md"),
    });
  });

  it.each([
    ["", "non-empty"],
    [42, "non-empty"],
    ["memories/user/a.md", "must start with /memories/"],
    ["/etc/passwd", "must start with /memories/"],
    ["/memories/user/../project/a.md", "'..'"],
    ["/memories/user/./a.md", "'..'"],
    ["/memories/user//a.md", "'..'"],
    ["/memories/user/%2e%2e%2fsecret.md", "URL-encoded"],
    ["/memories/user/..%2F..%2Fx.md", "URL-encoded"],
    ["/memories/user\\..\\a.md", "forward slashes"],
    ["/memories/user/.hidden.md", "hidden"],
    ["/memories/user/.git/config", "hidden"],
    ["/memories/user/a.txt", "Markdown"],
    ["/memories/user/a.MD", ".md"],
    ["/memories/user/a\u0000.md", "control"],
    ["/memories/workspace/a.md", "unknown memory scope"],
    ["/memories/other/a.md", "unknown memory scope"],
    [`/memories/user/${"x".repeat(200)}.md`, "too long"],
  ])("拒绝 %j", (path, message) => {
    expect(() => parseMemoryPath(path, roots)).toThrow(MemoryPathError);
    expect(() => parseMemoryPath(path, roots)).toThrow(message);
  });

  // Windows 建符号链接需要特权，CI 上跳过
  it.skipIf(process.platform === "win32")("作用域根以下的符号链接一律拒绝（防逃逸）", () => {
    const base = tmp();
    const root = join(base, "user");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "x.md"), "secret");
    symlinkSync(outside, join(root, "link"), "dir");
    symlinkSync(join(outside, "x.md"), join(root, "file.md"));
    expect(() => assertNoSymlink(root, join(root, "link", "x.md"))).toThrow("symbolic links");
    expect(() => assertNoSymlink(root, join(root, "file.md"))).toThrow("symbolic links");
    expect(() => assertNoSymlink(root, join(root, "missing", "a.md"))).not.toThrow();
  });
});

describe("项目根与分桶", () => {
  it("git 仓库取顶层；子目录同一个桶；非 git 取 cwd", () => {
    const repo = tmp();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    expect(projectRootOf(join(repo, "src", "deep"))).toBe(repo);
    const plain = tmp();
    expect(projectRootOf(plain)).toBe(plain);
  });

  it("worktree（.git 文件 + commondir）归到主仓库；子模块（无 commondir）取自己的检出", () => {
    const repo = tmp();
    mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const wt = tmp();
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    expect(projectRootOf(wt)).toBe(repo);
    const sub = join(repo, "vendor", "lib");
    mkdirSync(join(repo, ".git", "modules", "lib"), { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    expect(projectRootOf(sub)).toBe(sub);
  });

  it("桶名 = slug-sha8，按路径区分；目录不预先创建", () => {
    expect(projectBucket("/home/u/My Project!")).toMatch(/^My-Project-[0-9a-f]{8}$/);
    expect(projectBucket("/a/x")).not.toBe(projectBucket("/b/x"));
    expect(projectBucket("/")).toMatch(/^root-[0-9a-f]{8}$/);
    const r = standaloneRoots({ dataDir: "/d", projectRoot: "/w/app", user: true });
    expect(r.user).toBe(join("/d", "memory", "user"));
    expect(r.project).toBe(join("/d", "memory", "projects", projectBucket("/w/app")));
    expect(standaloneRoots({ dataDir: "/d", user: false })).toEqual({});
  });
});
