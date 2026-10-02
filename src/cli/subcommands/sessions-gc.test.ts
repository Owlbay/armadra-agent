import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobPath, putBlob } from "../../checkpoints/blobs.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { runDoctor } from "./doctor.js";
import { runSessions } from "./sessions.js";

let root: string;
let out: string[];
let io: CliIo;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ama-cp-cli-"));
  out = [];
  io = {
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { AMA_DATA_DIR: join(root, "data"), AMA_CONFIG_DIR: join(root, "config"), HOME: root },
    cwd: root,
    readStdin: async () => "",
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps: Pick<RuntimeDeps, "sessions"> = {
  sessions: { prune: async () => ({ moved: [] }) } as unknown as RuntimeDeps["sessions"],
};

describe("sessions prune 清理 file-history", () => {
  it("--dry-run 只报告；正式运行删除未引用的旧 blob", async () => {
    const dataDir = join(root, "data");
    const hash = await putBlob(dataDir, Buffer.from("orphan"));
    const old = (Date.now() - 3 * 86_400_000) / 1000;
    utimesSync(blobPath(dataDir, hash), old, old);
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeFileSync(join(dataDir, "sessions", "x.jsonl"), "{}\n");

    expect(await runSessions(["prune", "--dry-run"], io, deps)).toBe(0);
    expect(out.join("")).toContain("file-history：将清除 1 个未引用的备份");
    expect(existsSync(blobPath(dataDir, hash))).toBe(true);

    out = [];
    expect(await runSessions(["prune"], io, deps)).toBe(0);
    expect(out.join("")).toContain("file-history：已清除 1 个");
    expect(existsSync(blobPath(dataDir, hash))).toBe(false);
  });
});

describe("doctor 显示 file-history 占用", () => {
  it("备份数与大小", async () => {
    await putBlob(join(root, "data"), Buffer.from("abc"));
    await runDoctor([], io, undefined);
    expect(out.join("")).toMatch(/file-history：1 个备份，3 B（/);
  });

  it("有影子仓库时追加占用", async () => {
    const repo = join(root, "data", "file-history", "shadow", "0123456789abcdef");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "HEAD"), "ref: refs/heads/main\n");
    await runDoctor([], io, undefined);
    expect(out.join("")).toMatch(/file-history：0 个备份，0 B；影子仓库 1 个，21 B/);
  });

  it("[W5-I] 同时清理超过 7 天的剪贴板图片", async () => {
    const dir = join(root, "data", "clipboard");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "old.png");
    writeFileSync(old, "x");
    writeFileSync(join(dir, "new.png"), "x");
    const eightDays = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(old, eightDays, eightDays);
    expect(await runSessions(["prune", "--dry-run"], io, deps)).toBe(0);
    expect(out.join("")).toContain("clipboard：将清除 1 个");
    expect(existsSync(old)).toBe(true);
    expect(await runSessions(["prune"], io, deps)).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, "new.png"))).toBe(true);
  });
});
