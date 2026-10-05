import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../session/types.js";
import {
  createCheckpointBackendFactory,
  type CheckpointBackend,
  type CheckpointBackendContext,
  type CheckpointBackendSettings,
} from "./backend.js";
import { loadCheckpoints } from "./replay.js";
import { excludeLine, shadowRepoDir, shadowUsage, unsafeShadowCwd } from "./shadow-git.js";

const POSIX = process.platform !== "win32";

let root: string;
let cwd: string;
let dataDir: string;
let entries: SessionEntry[];
let turn: string | undefined;
let logs: string[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ama-shadow-")));
  cwd = join(root, "proj");
  dataDir = join(root, "data");
  mkdirSync(cwd);
  entries = [];
  turn = undefined;
  logs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctx(dir = cwd): CheckpointBackendContext {
  return {
    cwd: dir,
    entries: () => entries,
    appendCustom: (customType, data) =>
      entries.push({
        type: "custom",
        customType,
        data: JSON.parse(JSON.stringify(data)),
        id: `e${entries.length}`,
        parentId: null,
        timestamp: new Date().toISOString(),
      }),
    currentTurn: () => turn,
    log: (level, message) => logs.push(`${level}: ${message}`),
  };
}

function backend(extra: Partial<CheckpointBackendSettings> = {}, dir = cwd): CheckpointBackend {
  return createCheckpointBackendFactory({
    mode: "shadow-git",
    dataDir,
    ...extra,
    shadow: { homeDir: join(root, "home"), ...extra.shadow },
  })(ctx(dir))!;
}

async function snap(b: CheckpointBackend, id: string): Promise<void> {
  turn = id;
  await b.snapshot(id);
}

function shadowCommitOf(id: string): string | undefined {
  return loadCheckpoints(entries).byUserEntry.get(id)?.shadowCommit;
}

function write(rel: string, content: string): void {
  const path = join(cwd, ...rel.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function read(rel: string): string | undefined {
  const path = join(cwd, ...rel.split("/"));
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

/** bash 风格的直接改动：修改、删除、新增、重命名，外加一个被忽略的文件。 */
async function bashScenario(b: CheckpointBackend): Promise<void> {
  write(".gitignore", "ignored.txt\nbuild/\n");
  write("a.txt", "one\ntwo\n");
  write("b.txt", "bee\n");
  write("dir/c.txt", "sea\n");
  write("ignored.txt", "keep me\n");
  write("build/out.js", "old build\n");
  await snap(b, "u1");
  // 回合 u1 里 bash 的改动
  write("a.txt", "one\nTWO\nthree\n");
  unlinkSync(join(cwd, "b.txt"));
  write("d.txt", "new\n");
  renameSync(join(cwd, "dir", "c.txt"), join(cwd, "dir", "e.txt"));
  write("ignored.txt", "changed but ignored\n");
  write("build/out.js", "new build\n");
  await snap(b, "u2");
}

function expectRolledBack(): void {
  expect(read("a.txt")).toBe("one\ntwo\n");
  expect(read("b.txt")).toBe("bee\n");
  expect(read("dir/c.txt")).toBe("sea\n");
  expect(read("d.txt")).toBeUndefined();
  expect(read("dir/e.txt")).toBeUndefined();
  // 被忽略的文件不动
  expect(read("ignored.txt")).toBe("changed but ignored\n");
  expect(read("build/out.js")).toBe("new build\n");
}

describe("影子 git 回滚 bash 改动", () => {
  for (const kind of ["git 仓库", "非 git 目录"] as const) {
    it(`${kind}：新增 / 修改 / 删除 / 重命名都能回滚，忽略的文件不动`, async () => {
      if (kind === "git 仓库") gitInit(cwd);
      const b = backend();
      await bashScenario(b);
      expect(shadowCommitOf("u1")).toMatch(/^[0-9a-f]{40,64}$/);
      expect(shadowCommitOf("u2")).toMatch(/^[0-9a-f]{40,64}$/);
      expect(existsSync(join(shadowRepoDir(dataDir, cwd), "HEAD"))).toBe(true);

      const preview = await b.restore("u1", { dryRun: true, onConflict: "skip" });
      expect(preview.touched).toEqual([]);
      expect(preview.result.restored.sort()).toEqual(["a.txt", "b.txt", "dir/c.txt"]);
      expect(preview.result.deleted.sort()).toEqual(["d.txt", "dir/e.txt"]);
      expect(preview.result.conflicts).toEqual([]);
      expect(preview.result.insertions).toBe(1 + 1 + 1); // two、bee、sea
      expect(preview.result.deletions).toBe(2 + 1 + 1); // TWO、three、new、sea（e.txt）
      expect(read("a.txt")).toBe("one\nTWO\nthree\n");

      const done = await b.restore("u1", { dryRun: false, onConflict: "skip" });
      expect(done.result.failed).toEqual([]);
      expect(done.touched.length).toBe(5);
      expectRolledBack();
      expect(logs.filter((l) => l.startsWith("warn"))).toEqual([]);
      // 用户仓库的索引没被碰过
      if (kind === "git 仓库") expect(existsSync(join(cwd, ".git", "index"))).toBe(false);
    });
  }

  it("影子提交串成链：每个回合的父是上一个影子提交", async () => {
    const b = backend();
    write("a.txt", "1");
    await snap(b, "u1");
    write("a.txt", "2");
    await snap(b, "u2");
    const parent = execFileSync(
      "git",
      [`--git-dir=${shadowRepoDir(dataDir, cwd)}`, "rev-parse", `${shadowCommitOf("u2")}^`],
      { encoding: "utf8" },
    ).trim();
    expect(parent).toBe(shadowCommitOf("u1"));
  });

  it("cwd 是仓库子目录：上级 .gitignore 也生效", async () => {
    gitInit(root);
    writeFileSync(join(root, ".gitignore"), "secret.env\n");
    write("secret.env", "A=1\n");
    write("a.txt", "x\n");
    const b = backend();
    await snap(b, "u1");
    write("secret.env", "A=2\n");
    write("a.txt", "y\n");
    await snap(b, "u2");
    const done = await b.restore("u1", { dryRun: false, onConflict: "skip" });
    expect(done.result.restored).toEqual(["a.txt"]);
    expect(read("secret.env")).toBe("A=2\n");
  });

  it("换行与 .gitattributes 不影响内容：恢复的是原字节", async () => {
    write(".gitattributes", "* text=auto eol=lf\n");
    write("crlf.txt", "a\r\nb\r\n");
    const b = backend();
    await snap(b, "u1");
    write("crlf.txt", "changed\n");
    await snap(b, "u2");
    await b.restore("u1", { dryRun: false, onConflict: "skip" });
    expect(readFileSync(join(cwd, "crlf.txt")).toString("latin1")).toBe("a\r\nb\r\n");
  });

  it.runIf(POSIX)("可执行位按目标恢复，其余权限位保留", async () => {
    write("run.sh", "#!/bin/sh\n");
    chmodSync(join(cwd, "run.sh"), 0o750);
    const b = backend();
    await snap(b, "u1");
    write("run.sh", "#!/bin/sh\necho hi\n");
    chmodSync(join(cwd, "run.sh"), 0o640);
    await snap(b, "u2");
    await b.restore("u1", { dryRun: false, onConflict: "skip" });
    expect(read("run.sh")).toBe("#!/bin/sh\n");
    expect(statSync(join(cwd, "run.sh")).mode & 0o777).toBe(0o750);
  });
});

describe("冲突", () => {
  async function scenario(): Promise<CheckpointBackend> {
    const b = backend();
    write("a.txt", "v1\n");
    write("b.txt", "b1\n");
    await snap(b, "u1");
    write("a.txt", "v2\n"); // 回合内 bash 改的
    write("b.txt", "b2\n");
    await snap(b, "u2");
    write("a.txt", "manual\n"); // 回合外的手动修改
    return b;
  }

  it("skip：回合外改过的文件列入 conflicts 不动，其它照常恢复", async () => {
    const b = await scenario();
    const done = await b.restore("u1", { dryRun: false, onConflict: "skip" });
    expect(done.result.conflicts).toEqual(["a.txt"]);
    expect(done.result.restored).toEqual(["b.txt"]);
    expect(read("a.txt")).toBe("manual\n");
    expect(read("b.txt")).toBe("b1\n");
  });

  it("overwrite：冲突文件也覆盖", async () => {
    const b = await scenario();
    const done = await b.restore("u1", { dryRun: false, onConflict: "overwrite" });
    expect(done.result.conflicts).toEqual(["a.txt"]);
    expect(done.result.restored.sort()).toEqual(["a.txt", "b.txt"]);
    expect(read("a.txt")).toBe("v1\n");
  });

  it("ama 自己写的（afterWrite）不算冲突", async () => {
    const b = backend();
    write("a.txt", "v1\n");
    await snap(b, "u1");
    const file = join(cwd, "a.txt");
    await b.hooks.beforeWrite(file);
    writeFileSync(file, "by ama\n");
    b.hooks.afterWrite(file, "by ama\n");
    const done = await b.restore("u1", { dryRun: false, onConflict: "skip" });
    expect(done.result.conflicts).toEqual([]);
    expect(done.result.restored).toEqual(["a.txt"]);
    expect(read("a.txt")).toBe("v1\n");
  });

  it("edit / write 跟踪的被忽略文件按 tools 记录恢复", async () => {
    write(".gitignore", ".env\n");
    write(".env", "A=1\n");
    const b = backend();
    await snap(b, "u1");
    const file = join(cwd, ".env");
    await b.hooks.beforeWrite(file);
    writeFileSync(file, "A=2\n");
    b.hooks.afterWrite(file, "A=2\n");
    const done = await b.restore("u1", { dryRun: false, onConflict: "skip" });
    expect(done.result.restored).toEqual([".env"]);
    expect(read(".env")).toBe("A=1\n");
  });
});

describe("护栏与降级", () => {
  function warnings(): string[] {
    return logs.filter((l) => l.startsWith("warn"));
  }

  it("文件数超限：本会话降级为 tools，检查点没有影子提交", async () => {
    write("a.txt", "1");
    write("b.txt", "2");
    write("c.txt", "3");
    const b = backend({ shadow: { maxFiles: 2 } });
    await snap(b, "u1");
    expect(shadowCommitOf("u1")).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("3 个文件");
    await snap(b, "u2");
    expect(warnings()).toHaveLength(1);
    // tools 照常：edit / write 跟踪的文件可回滚
    const file = join(cwd, "a.txt");
    await b.hooks.beforeWrite(file);
    writeFileSync(file, "x");
    b.hooks.afterWrite(file, "x");
    const done = await b.restore("u2", { dryRun: false, onConflict: "skip" });
    expect(done.result.restored).toEqual(["a.txt"]);
    expect(read("a.txt")).toBe("1");
  });

  it("快照超时：这次的提交保留，之后降级", async () => {
    let clock = 0;
    const b = backend({ shadow: { maxSnapshotMs: 50, now: () => (clock += 100) } });
    write("a.txt", "1");
    await snap(b, "u1");
    expect(shadowCommitOf("u1")).toBeDefined();
    expect(warnings()[0]).toContain("秒");
    write("a.txt", "2");
    await snap(b, "u2");
    expect(shadowCommitOf("u2")).toBeUndefined();
    // u1 的影子提交照样能用（u2 之后的改动以 u1 为基线，算冲突；覆盖即可）
    const done = await b.restore("u1", { dryRun: false, onConflict: "overwrite" });
    expect(done.result.restored).toEqual(["a.txt"]);
    expect(read("a.txt")).toBe("1");
  });

  it("快照计时不含一次性的建仓（Windows 起 git 子进程慢，曾让第一回合就判超时降级）", async () => {
    const initializedAtClock: boolean[] = [];
    const b = backend({
      shadow: {
        now: () => {
          initializedAtClock.push(
            existsSync(join(shadowRepoDir(dataDir, cwd), "ama-config-version")),
          );
          return 0;
        },
      },
    });
    write("a.txt", "1");
    await snap(b, "u1");
    expect(shadowCommitOf("u1")).toBeDefined();
    expect(initializedAtClock.length).toBeGreaterThan(0);
    expect(initializedAtClock.every(Boolean)).toBe(true);
  });

  it("PATH 里没有 git：降级并提示", async () => {
    const b = backend({ shadow: { env: { PATH: "" } } });
    write("a.txt", "1");
    await snap(b, "u1");
    expect(shadowCommitOf("u1")).toBeUndefined();
    expect(warnings()[0]).toContain("找不到 git");
    expect(loadCheckpoints(entries).byUserEntry.has("u1")).toBe(true);
  });

  it("git 可执行文件不存在：同样降级", async () => {
    const b = backend({ shadow: { git: join(root, "no-such-git") } });
    await snap(b, "u1");
    expect(warnings()[0]).toContain("找不到 git");
  });

  it("cwd 是家目录或根目录：不启用", async () => {
    const b = backend({ shadow: { homeDir: cwd } });
    await snap(b, "u1");
    expect(shadowCommitOf("u1")).toBeUndefined();
    expect(warnings()[0]).toContain("家目录");
    expect(existsSync(shadowRepoDir(dataDir, cwd))).toBe(false);
    expect(unsafeShadowCwd(POSIX ? "/" : "C:\\", "/nowhere")).toContain("根目录");
    expect(unsafeShadowCwd(cwd, "/nowhere")).toBeUndefined();
  });

  it("tools 模式不建影子仓库", async () => {
    const b = createCheckpointBackendFactory({ mode: "tools", dataDir })(ctx())!;
    write("a.txt", "1");
    await snap(b, "u1");
    expect(shadowCommitOf("u1")).toBeUndefined();
    expect(existsSync(shadowRepoDir(dataDir, cwd))).toBe(false);
  });

  it("影子提交丢失时回退 tools 记录", async () => {
    const b = backend();
    write("a.txt", "1");
    await snap(b, "u1");
    rmSync(shadowRepoDir(dataDir, cwd), { recursive: true, force: true });
    const file = join(cwd, "a.txt");
    await b.hooks.beforeWrite(file);
    writeFileSync(file, "2");
    b.hooks.afterWrite(file, "2");
    const done = await b.restore("u1", { dryRun: false, onConflict: "skip" });
    expect(done.result.restored).toEqual(["a.txt"]);
    expect(read("a.txt")).toBe("1");
    expect(warnings()[0]).toContain("改按 tools");
  });
});

describe("辅助", () => {
  it("shadowUsage 统计影子仓库", async () => {
    expect(await shadowUsage(dataDir)).toEqual({ repos: 0, bytes: 0 });
    const b = backend();
    write("a.txt", "1");
    await snap(b, "u1");
    const usage = await shadowUsage(dataDir);
    expect(usage.repos).toBe(1);
    expect(usage.bytes).toBeGreaterThan(0);
  });

  it("excludeLine 锚定并转义通配符", () => {
    expect(excludeLine("node_modules/")).toBe("/node_modules/");
    expect(excludeLine("a*b?[c].txt")).toBe("/a\\*b\\?\\[c\\].txt");
    expect(excludeLine("!x #y")).toBe("/\\!x \\#y");
    expect(excludeLine("bad\nname")).toBeUndefined();
  });
});
