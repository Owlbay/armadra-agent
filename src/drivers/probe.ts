/**
 * 外部 Agent 的探测（docs/wave5-plan.md §5.1 probe.ts）。[W5-E]
 *
 * - PATH 查找不起 shell：逐个目录拼程序名（Windows 加 PATHEXT 后缀）；绝对 / 相对路径直接认。
 * - 版本：`<program> --version` 取第一个 `x.y.z`，5 s 超时，不联网、不计费。
 * - 缓存：每进程一次（内存）；可选写 `<dataDir>/drivers.json`（按路径 + mtime 失效）。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { commandLine } from "./process.js";

export const VERSION_TIMEOUT_MS = 5_000;

export interface LocatedProgram {
  path: string;
  version?: string;
}

export interface ProbeDeps {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  /** 缺省：存在且是文件。 */
  isFile?(path: string): boolean;
  /** 缺省：execFile `<path> <args>`，返回 stdout + stderr；失败返回 undefined。 */
  runVersion?(path: string, args: readonly string[]): Promise<string | undefined>;
  /** `<dataDir>/drivers.json`；不给则只做内存缓存。 */
  cacheFile?: string;
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 在 PATH 里找程序；找不到返回 undefined。 */
export function findOnPath(
  program: string,
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; cwd?: string; isFile?(path: string): boolean } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const exts =
    platform === "win32"
      ? ["", ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  const candidates = (base: string): string[] => exts.map((ext) => base + ext.toLowerCase());
  if (isAbsolute(program) || program.includes("/") || program.includes("\\")) {
    const base = resolve(options.cwd ?? process.cwd(), program);
    return candidates(base).find(isFile);
  }
  const path = env["PATH"] ?? env["Path"] ?? "";
  const sep = platform === "win32" ? ";" : delimiter;
  for (const dir of path.split(sep)) {
    if (dir === "") continue;
    const hit = candidates(join(dir, program)).find(isFile);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 文本里第一个 `x.y.z`（可带预发布后缀）。 */
export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)?.[1];
}

function compare(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map(Number);
  const pb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 版本区间：空格分隔的 `>=x.y.z` / `<x.y.z` / `>` / `<=` / `=`；全部满足为真。 */
export function versionSatisfies(version: string, range: string): boolean {
  for (const part of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
    if (m === null) continue;
    const c = compare(version, m[2]!);
    const op = m[1] ?? "=";
    const ok =
      op === ">="
        ? c >= 0
        : op === "<="
          ? c <= 0
          : op === ">"
            ? c > 0
            : op === "<"
              ? c < 0
              : c === 0;
    if (!ok) return false;
  }
  return true;
}

function defaultRunVersion(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): (path: string, args: readonly string[]) => Promise<string | undefined> {
  return (path, args) =>
    new Promise((done) => {
      const line = commandLine({ program: path, args, env }, platform);
      execFile(
        line.file,
        line.args,
        {
          env,
          timeout: VERSION_TIMEOUT_MS,
          windowsHide: true,
          windowsVerbatimArguments: line.verbatim,
        },
        (error, stdout, stderr) =>
          done(error !== null && stdout === "" ? undefined : `${stdout}${stderr}`),
      );
    });
}

interface CacheEntry {
  mtimeMs: number;
  version?: string;
}

export class ProgramProbe {
  private readonly memo = new Map<string, Promise<LocatedProgram | undefined>>();

  constructor(private readonly deps: ProbeDeps) {}

  /** 找程序并取版本；同一进程同一程序只探一次。 */
  locate(
    program: string,
    versionArgs: readonly string[] = ["--version"],
  ): Promise<LocatedProgram | undefined> {
    const key = `${program}\0${versionArgs.join(" ")}`;
    let hit = this.memo.get(key);
    if (hit === undefined) {
      hit = this.locateNow(program, versionArgs);
      this.memo.set(key, hit);
    }
    return hit;
  }

  private async locateNow(
    program: string,
    versionArgs: readonly string[],
  ): Promise<LocatedProgram | undefined> {
    const platform = this.deps.platform ?? process.platform;
    const path = findOnPath(program, this.deps.env, {
      platform,
      ...(this.deps.cwd !== undefined ? { cwd: this.deps.cwd } : {}),
      ...(this.deps.isFile !== undefined ? { isFile: this.deps.isFile } : {}),
    });
    if (path === undefined) return undefined;
    const mtimeMs = this.mtime(path);
    const cached = this.readCache()[path];
    if (cached !== undefined && cached.mtimeMs === mtimeMs)
      return { path, ...(cached.version !== undefined ? { version: cached.version } : {}) };
    const run = this.deps.runVersion ?? defaultRunVersion(this.deps.env, platform);
    const output = await run(path, versionArgs).catch(() => undefined);
    const version = output === undefined ? undefined : parseVersion(output);
    this.writeCache(path, { mtimeMs, ...(version !== undefined ? { version } : {}) });
    return { path, ...(version !== undefined ? { version } : {}) };
  }

  private mtime(path: string): number {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }

  private readCache(): Record<string, CacheEntry> {
    const file = this.deps.cacheFile;
    if (file === undefined || !existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        programs?: Record<string, CacheEntry>;
      };
      return parsed.programs ?? {};
    } catch {
      return {};
    }
  }

  private writeCache(path: string, entry: CacheEntry): void {
    const file = this.deps.cacheFile;
    if (file === undefined) return;
    try {
      const programs = { ...this.readCache(), [path]: entry };
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ version: 1, programs }, null, 2)}\n`);
    } catch {
      // 缓存写不进去不影响探测
    }
  }
}
