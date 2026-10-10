/**
 * 影子 git 仓库（docs/history/rewind-plan.md §6）。[RW-D]
 *
 * - 位置 `<dataDir>/file-history/shadow/<sha256(cwd) 前 16>/`，用 `--git-dir` 指向它、`--work-tree` 指向 cwd；
 *   不碰用户仓库的对象、索引与引用。git 以子进程调用（零运行时依赖）。
 * - 隔离：清掉继承的 `GIT_*` 环境变量；全局 / 系统配置指向空文件（不读用户的签名、钩子、过滤器、模板）；
 *   本地配置写固定身份、`core.autocrlf=false`、`core.hooksPath` 指向空目录、`gc.auto=0` 等；
 *   `info/attributes` 关掉换行转换与过滤器，存进去的就是磁盘原字节。
 * - 忽略：工作区里的 `.gitignore` 由 git 自己读；cwd 在用户仓库里时，再把用户仓库判定为忽略的路径
 *   （含上级目录的 `.gitignore`、`info/exclude`、全局忽略文件）逐条写进影子仓库的 `info/exclude`；`.git` 一律排除。
 * - 索引：每个进程一个（`GIT_INDEX_FILE=ama-index-<pid>`），同进程内对同一影子仓库的操作串行；
 *   已退出进程留下的索引在初始化时清掉。
 * - 快照：`add -A` + `write-tree` + `commit-tree`（父为上一个影子提交）。提交不挂引用，`gc.auto=0` 且
 *   `gc.pruneExpire=never`，不会被自动回收。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { fileHistoryDir } from "./blobs.js";
import { msg } from "../i18n/index.js";

export const SHADOW_DIR = "shadow";
/** cwd 下（不含忽略的）文件数上限，超出本会话降级为 tools。 */
export const SHADOW_MAX_FILES = 20_000;
/** 单次快照耗时上限（毫秒），连续 `SHADOW_SLOW_STREAK` 次超出本会话降级为 tools。 */
export const SHADOW_MAX_SNAPSHOT_MS = 3_000;
/** 连续这么多次快照超时才降级（首次快照不计）。 */
export const SHADOW_SLOW_STREAK = 2;
/** 单个 git 进程的硬上限，防止卡死。 */
const GIT_TIMEOUT_MS = 60_000;
/** 本地配置的版本；改了配置项就加一，旧仓库会补写。 */
const CONFIG_VERSION = "1";
const IDENTITY = { name: "ama", email: "ama@localhost" };
const ATTRIBUTES = "* -text -eol -filter -ident -working-tree-encoding\n";

export function shadowRoot(dataDir: string): string {
  return join(fileHistoryDir(dataDir), SHADOW_DIR);
}

/** cwd 对应的影子仓库目录。 */
export function shadowRepoDir(dataDir: string, cwd: string): string {
  const digest = createHash("sha256").update(resolve(cwd)).digest("hex");
  return join(shadowRoot(dataDir), digest.slice(0, 16));
}

/** cwd 是家目录或文件系统根时不启用影子 git，返回原因。 */
export function unsafeShadowCwd(cwd: string, home: string = homedir()): string | undefined {
  const abs = resolve(cwd);
  if (parse(abs).root === abs) return msg().session.checkpoints.cwdIsRoot;
  if (home !== "" && sameDir(abs, resolve(home))) return msg().session.checkpoints.cwdIsHome;
  return undefined;
}

function sameDir(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** git 不在 PATH（或指定的可执行文件不存在）。 */
export class GitMissingError extends Error {
  constructor() {
    super(msg().session.checkpoints.gitNotFound);
  }
}

export interface ShadowGitOptions {
  /** git 可执行文件（缺省 `git`，按 PATH 查找）。 */
  git?: string;
  /** 子进程环境（缺省 process.env；`GIT_*` 一律去掉）。 */
  env?: NodeJS.ProcessEnv;
  /** 缺省 `SHADOW_MAX_FILES`。 */
  maxFiles?: number;
  /** 缺省 `SHADOW_MAX_SNAPSHOT_MS`。 */
  maxSnapshotMs?: number;
  /** 测试用：时钟。 */
  now?(): number;
}

export type ShadowDisabledReason = "too_many_files" | "too_slow";

export interface ShadowSnapshot {
  /** 提交 id；文件数超限时没有提交。 */
  commit?: string;
  /** 本次快照后应降级的原因。 */
  degrade?: { reason: ShadowDisabledReason; message: string };
}

/** diff-tree 的一项（old = 第一个树，new = 第二个树）。 */
export interface ShadowChange {
  path: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: string;
}

export const MODE_ABSENT = "000000";
export const MODE_SYMLINK = "120000";
export const MODE_GITLINK = "160000";
export const MODE_EXECUTABLE = "100755";

const queues = new Map<string, Promise<unknown>>();

/** 同进程内对同一影子仓库的操作串行（共用一个索引文件）。 */
function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

interface RunOptions {
  input?: string | Buffer;
  /** 非零退出也接受，只要没有 `fatal:`（`add --ignore-errors` 遇到读不了的文件时）。 */
  allowFailure?: boolean;
  /** 在用户仓库里执行（不加 --git-dir / --work-tree，不隔离配置）。 */
  userRepo?: boolean;
}

export class ShadowRepo {
  readonly dir: string;
  readonly cwd: string;
  private readonly git: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly maxFiles: number;
  private readonly maxSnapshotMs: number;
  private readonly options: ShadowGitOptions;
  private readonly indexFile: string;
  private initialized: Promise<void> | undefined;
  private counted = false;
  /** 连续超时的快照数（首次快照不计），到 `SHADOW_SLOW_STREAK` 才降级。 */
  private slowStreak = 0;

  constructor(dataDir: string, cwd: string, options: ShadowGitOptions = {}) {
    this.cwd = resolve(cwd);
    this.dir = shadowRepoDir(dataDir, this.cwd);
    this.options = options;
    this.git = options.git ?? "git";
    this.baseEnv = stripGitEnv(options.env ?? process.env);
    this.maxFiles = options.maxFiles ?? SHADOW_MAX_FILES;
    this.maxSnapshotMs = options.maxSnapshotMs ?? SHADOW_MAX_SNAPSHOT_MS;
    this.indexFile = join(this.dir, `ama-index-${process.pid}`);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private env(): NodeJS.ProcessEnv {
    const empty = join(this.dir, "ama-empty");
    return {
      ...this.baseEnv,
      GIT_INDEX_FILE: this.indexFile,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: empty,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
    };
  }

  /** 在影子仓库上执行 git（stdout 原字节）。 */
  private run(args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
    const full =
      options.userRepo === true
        ? [...args]
        : [`--git-dir=${this.dir}`, `--work-tree=${this.cwd}`, ...args];
    return runGit(this.git, full, {
      cwd: this.cwd,
      env: options.userRepo === true ? this.baseEnv : this.env(),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.allowFailure !== undefined ? { allowFailure: options.allowFailure } : {}),
    });
  }

  private async text(args: readonly string[]): Promise<string> {
    return (await this.run(args)).toString("utf8").trim();
  }

  /** 建仓库与本地配置（每个实例一次；已是当前版本则只清理残留索引）。 */
  init(): Promise<void> {
    this.initialized ??= this.doInit().catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async doInit(): Promise<void> {
    const hooks = join(this.dir, "ama-hooks");
    await mkdir(hooks, { recursive: true, mode: 0o700 });
    await writeFile(join(this.dir, "ama-empty"), "", { flag: "a", mode: 0o600 });
    await writeFile(join(this.dir, "ama-cwd"), `${this.cwd}\n`, { mode: 0o600 });
    const version = await readSmall(join(this.dir, "ama-config-version"));
    if (version !== CONFIG_VERSION) {
      if (!(await exists(join(this.dir, "HEAD")))) {
        await runGit(this.git, ["init", "-q", "--bare", `--template=${hooks}`, this.dir], {
          cwd: this.cwd,
          env: this.env(),
        });
      }
      const config: [string, string][] = [
        ["core.bare", "false"],
        ["core.autocrlf", "false"],
        ["core.safecrlf", "false"],
        ["core.hooksPath", hooks.split("\\").join("/")],
        ["core.fsmonitor", "false"],
        ["core.untrackedCache", "false"],
        ["core.quotePath", "false"],
        ["core.longpaths", "true"],
        ["core.excludesFile", join(this.dir, "ama-empty").split("\\").join("/")],
        ["core.attributesFile", join(this.dir, "ama-empty").split("\\").join("/")],
        ["gc.auto", "0"],
        ["gc.autoDetach", "false"],
        ["gc.pruneExpire", "never"],
        ["maintenance.auto", "false"],
        ["commit.gpgSign", "false"],
        ["user.name", IDENTITY.name],
        ["user.email", IDENTITY.email],
        ["user.useConfigOnly", "true"],
      ];
      for (const [key, value] of config) await this.run(["config", key, value]);
      await mkdir(join(this.dir, "info"), { recursive: true });
      await writeFile(join(this.dir, "info", "attributes"), ATTRIBUTES);
      await writeFile(join(this.dir, "ama-config-version"), CONFIG_VERSION);
    }
    await removeStaleIndexes(this.dir);
  }

  /** 把用户仓库判定为忽略的路径写进影子仓库的 info/exclude（cwd 不在仓库里时只排除 .git）。 */
  private async writeExcludes(): Promise<void> {
    const lines = ["/.git", ".git"];
    try {
      const out = await this.run(
        ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
        { userRepo: true },
      );
      for (const path of splitZ(out)) {
        const line = excludeLine(path);
        if (line !== undefined) lines.push(line);
      }
    } catch (error) {
      if (error instanceof GitMissingError) throw error;
      // 不在 git 仓库里：只靠工作区里的 .gitignore
    }
    await mkdir(join(this.dir, "info"), { recursive: true });
    await writeFile(join(this.dir, "info", "exclude"), `${lines.join("\n")}\n`);
  }

  /** 把工作区收进索引并写树，返回树 id（调用前已 writeExcludes）。 */
  private async stageTree(): Promise<string> {
    await this.run(["add", "-A", "--ignore-errors"], { allowFailure: true });
    return this.text(["write-tree"]);
  }

  /** 新回合快照：返回提交 id 与是否该降级。 */
  snapshot(parent: string | undefined, message: string): Promise<ShadowSnapshot> {
    return exclusive(this.dir, async () => {
      await this.init();
      // 计时不含一次性的建仓与本地配置（十来个 git 子进程，Windows 上可达数秒），只量快照本身
      const started = this.now();
      // 首次快照要把整个工作区读进索引，天然偏慢，不计入超时
      const first = !this.counted;
      await this.writeExcludes();
      if (!this.counted) {
        const out = await this.run([
          "ls-files",
          "-z",
          "--others",
          "--cached",
          "--exclude-standard",
        ]);
        const files = countZ(out);
        this.counted = true;
        if (files > this.maxFiles) {
          return {
            degrade: {
              reason: "too_many_files",
              message: msg().session.checkpoints.tooManyFiles(files, this.maxFiles),
            },
          };
        }
      }
      const tree = await this.stageTree();
      const args = ["commit-tree", tree, "-m", message];
      if (parent !== undefined && (await this.hasCommitUnlocked(parent))) args.push("-p", parent);
      const commit = await this.text(args);
      const elapsed = this.now() - started;
      if (first) return { commit };
      this.slowStreak = elapsed > this.maxSnapshotMs ? this.slowStreak + 1 : 0;
      if (this.slowStreak >= SHADOW_SLOW_STREAK) {
        return {
          commit,
          degrade: {
            reason: "too_slow",
            message: msg().session.checkpoints.tooSlow(
              (elapsed / 1000).toFixed(1),
              this.maxSnapshotMs / 1000,
            ),
          },
        };
      }
      return { commit };
    });
  }

  /** 当前工作区的树（恢复时与目标提交比较）。 */
  currentTree(): Promise<string> {
    return exclusive(this.dir, async () => {
      await this.init();
      await this.writeExcludes();
      return this.stageTree();
    });
  }

  private async hasCommitUnlocked(id: string): Promise<boolean> {
    if (!/^[0-9a-f]{40,64}$/.test(id)) return false;
    try {
      await this.run(["cat-file", "-e", `${id}^{commit}`]);
      return true;
    } catch (error) {
      if (error instanceof GitMissingError) throw error;
      return false;
    }
  }

  hasCommit(id: string): Promise<boolean> {
    return exclusive(this.dir, async () => {
      await this.init();
      return this.hasCommitUnlocked(id);
    });
  }

  /** 两个树（提交或树 id）之间的差异，不识别重命名。 */
  async diff(from: string, to: string): Promise<ShadowChange[]> {
    const out = await this.run(["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to]);
    const parts = splitZ(out);
    const changes: ShadowChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(parts[i] as string);
      if (meta === null) continue;
      changes.push({
        oldMode: meta[1] as string,
        newMode: meta[2] as string,
        oldOid: meta[3] as string,
        newOid: meta[4] as string,
        status: meta[5] as string,
        path: parts[i + 1] as string,
      });
    }
    return changes;
  }

  /** 树里的全部文件路径。 */
  async paths(treeish: string): Promise<Set<string>> {
    return new Set(splitZ(await this.run(["ls-tree", "-r", "-z", "--name-only", treeish])));
  }

  /** 读一批 blob；超过 maxBytes 或不存在的不返回。 */
  async readBlobs(oids: readonly string[], maxBytes: number): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    const unique = [...new Set(oids)];
    if (unique.length === 0) return out;
    const sizes = (
      await this.run(["cat-file", "--batch-check"], { input: `${unique.join("\n")}\n` })
    )
      .toString("utf8")
      .split("\n");
    const wanted: string[] = [];
    for (const line of sizes) {
      const [oid, type, size] = line.split(" ");
      if (oid !== undefined && type === "blob" && Number(size) <= maxBytes) wanted.push(oid);
    }
    if (wanted.length === 0) return out;
    const data = await this.run(["cat-file", "--batch"], { input: `${wanted.join("\n")}\n` });
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(0x0a, offset);
      if (newline < 0) break;
      const [oid, type, size] = data.subarray(offset, newline).toString("utf8").split(" ");
      offset = newline + 1;
      if (type === "missing" || oid === undefined) continue;
      const length = Number(size);
      out.set(oid, Buffer.from(data.subarray(offset, offset + length)));
      offset += length + 1;
    }
    return out;
  }
}

/** 影子仓库占用（doctor 用）。 */
export async function shadowUsage(dataDir: string): Promise<{ repos: number; bytes: number }> {
  const usage = { repos: 0, bytes: 0 };
  let names: string[];
  try {
    names = await readdir(shadowRoot(dataDir));
  } catch {
    return usage;
  }
  for (const name of names) {
    const dir = join(shadowRoot(dataDir), name);
    if (!/^[0-9a-f]{16}$/.test(name) || !(await exists(join(dir, "HEAD")))) continue;
    usage.repos++;
    usage.bytes += await duBytes(dir);
  }
  return usage;
}

async function duBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await duBytes(full);
    else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // 并发删除
      }
    }
  }
  return total;
}

function stripGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith("GIT_")) out[key] = value;
  }
  return out;
}

function runGit(
  git: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string | Buffer;
    allowFailure?: boolean;
  },
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(git, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(isMissing(error) ? new GitMissingError() : error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(isMissing(error) ? new GitMissingError() : error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const errText = Buffer.concat(stderr).toString("utf8");
      const tolerated =
        options.allowFailure === true && signal === null && !/^fatal:/m.test(errText);
      if (code === 0 || tolerated) {
        resolvePromise(Buffer.concat(stdout));
        return;
      }
      const detail = errText.trim().split("\n").slice(-2).join("; ");
      reject(
        new Error(
          msg().session.checkpoints.gitFailed(
            args.find((a) => !a.startsWith("--")) ?? "",
            String(signal ?? code),
            detail,
          ),
        ),
      );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES";
}

function splitZ(out: Buffer): string[] {
  const text = out.toString("utf8");
  if (text === "") return [];
  const parts = text.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function countZ(out: Buffer): number {
  let n = 0;
  for (const byte of out) if (byte === 0) n++;
  return n;
}

/** 用户仓库给出的忽略路径 → 锚定到根的 exclude 行（通配符转义；带换行的名字放弃）。 */
export function excludeLine(path: string): string | undefined {
  if (path === "" || path.includes("\n") || path.includes("\r")) return undefined;
  const escaped = path.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/ $/, "\\ ");
  return `/${escaped}`;
}

async function removeStaleIndexes(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^ama-index-(\d+)(\.lock)?$/.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    await rm(join(dir, name), { force: true }).catch(() => undefined);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readSmall(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return undefined;
  }
}
