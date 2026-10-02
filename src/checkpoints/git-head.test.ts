import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitHead } from "./git-head.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ama-cp-git-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function repo(dir: string): string {
  const git = join(dir, ".git");
  mkdirSync(join(git, "refs", "heads"), { recursive: true });
  return git;
}

describe("readGitHead", () => {
  it("普通仓库：分支引用，从子目录向上找", async () => {
    const git = repo(root);
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(git, "refs", "heads", "main"), `${A}\n`);
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    expect(await readGitHead(join(root, "src", "deep"))).toEqual({ head: A, branch: "main" });
  });

  it("packed-refs 里的分支", async () => {
    const git = repo(root);
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/feat/x\n");
    writeFileSync(join(git, "packed-refs"), `# pack-refs with: peeled\n${B} refs/heads/feat/x\n`);
    expect(await readGitHead(root)).toEqual({ head: B, branch: "feat/x" });
  });

  it("detached HEAD 没有 branch", async () => {
    const git = repo(root);
    writeFileSync(join(git, "HEAD"), `${A}\n`);
    expect(await readGitHead(root)).toEqual({ head: A });
  });

  it("worktree：.git 文件指向 gitdir，分支引用在 commondir", async () => {
    const main = join(root, "main");
    const git = repo(main);
    writeFileSync(join(git, "refs", "heads", "wt"), `${B}\n`);
    const wtGit = join(git, "worktrees", "wt");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "HEAD"), "ref: refs/heads/wt\n");
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    expect(await readGitHead(wt)).toEqual({ head: B, branch: "wt" });
  });

  it("相对 gitdir 与未提交过的分支", async () => {
    const real = join(root, "store");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "HEAD"), "ref: refs/heads/main\n");
    const work = join(root, "work");
    mkdirSync(work);
    writeFileSync(join(work, ".git"), "gitdir: ../store\n");
    expect(await readGitHead(work)).toBeUndefined();
  });
});
