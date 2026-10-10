/**
 * `ama memory`（docs/history/wave6-plan.md §3.5）：list / show / path / rm / edit / enable / disable 的输出快照。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { recordTrust } from "../../config/trust.js";
import { main } from "../main.js";
import { runMemory, type MemoryCliDeps } from "./memory.js";

let home: TmpHome;
let out: string[];
let err: string[];
beforeEach(() => {
  home = createTmpHome();
  out = [];
  err = [];
});
afterEach(() => home.cleanup());

const configDir = (): string => home.env["AMA_CONFIG_DIR"]!;
const dataDir = (): string => home.env["AMA_DATA_DIR"]!;

function io(tty = false) {
  return {
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    env: { ...home.env, AMA_NO_LOCAL_PROBE: "1" },
    cwd: home.cwd,
    stdinIsTTY: tty,
    stdoutIsTTY: false,
    readStdin: async () => "",
  };
}

const ama = (argv: string[], deps: MemoryCliDeps = {}, tty = false): Promise<number> =>
  runMemory(argv, io(tty), deps);

function seed(): void {
  home.write(
    "home/.local/share/ama/memory/user/prefers-pnpm.md",
    "---\nname: prefers-pnpm\ndescription: 用 pnpm\ntype: user\nupdated: 2026-10-01\n---\n\n用 pnpm。\n",
  );
}

describe("ama memory", () => {
  it("无参数打印用法（退出码 2）；--help 退出码 0；经 main 分派", async () => {
    expect(await ama([])).toBe(2);
    expect(out.join("")).toContain("用法：ama memory list");
    expect(await ama(["--help"])).toBe(0);
    out = [];
    expect(
      await main(["memory", "path", "--scope", "user"], { processHooks: false, io: io() }),
    ).toBe(0);
    expect(out.join("")).toBe(`user\t${join(dataDir(), "memory", "user")}\n`);
  });

  it("list：未受信任跳过项目作用域并提示；未开启时说明条目不使用；--json", async () => {
    seed();
    expect(await ama(["list"])).toBe(0);
    expect(out.join("")).toBe(
      "用户 /memories/user/ · 1 条 · 索引 62 B / 4.0 KiB\n" +
        "  prefers-pnpm [prefers-pnpm.md] — 用 pnpm · 更新于 2026-10-01\n",
    );
    expect(err.join("")).toContain("跳过项目作用域");
    expect(err.join("")).toContain("memory.enabled 为 false");
    out = [];
    recordTrust(configDir(), home.cwd, true);
    expect(await ama(["list", "--json", "--scope", "all"])).toBe(0);
    const json = JSON.parse(out.join("")) as { scope: string; entries: unknown[] }[];
    expect(json.map((s) => [s.scope, s.entries.length])).toEqual([
      ["user", 1],
      ["project", 0],
    ]);
    expect(await ama(["list", "--scope", "nope"])).toBe(2);
    expect(err.join("")).toContain("未知作用域 nope");
  });

  it("show / rm：找不到退出码 2；非终端删除需 --yes；终端里确认", async () => {
    seed();
    expect(await ama(["show", "prefers-pnpm"])).toBe(0);
    expect(out.join("")).toContain("用 pnpm。");
    expect(await ama(["show", "missing"])).toBe(2);
    expect(await ama(["rm", "prefers-pnpm"])).toBe(2);
    expect(err.join("")).toContain("删除需加 --yes");
    const file = join(dataDir(), "memory", "user", "prefers-pnpm.md");
    expect(await ama(["rm", "prefers-pnpm"], { confirm: async () => false }, true)).toBe(0);
    expect(existsSync(file)).toBe(true);
    let asked = "";
    const confirm = async (q: string) => ((asked = q), true);
    expect(await ama(["rm", "prefers-pnpm"], { confirm }, true)).toBe(0);
    expect(asked).toBe("删除 /memories/user/prefers-pnpm.md？");
    expect(existsSync(file)).toBe(false);
    seed();
    expect(await ama(["rm", "prefers-pnpm", "--yes"])).toBe(0);
    expect(out.join("")).toContain("已删除 /memories/user/prefers-pnpm.md");
  });

  it("edit：改副本存回；凭据拒写（退出码 1）；--scope 新建条目", async () => {
    seed();
    const edit = (next: string): MemoryCliDeps => ({ edit: async (text) => `${text}${next}` });
    expect(await ama(["edit", "prefers-pnpm"], edit("\nCI 也用。"))).toBe(0);
    expect(out.join("")).toContain("已保存 /memories/user/prefers-pnpm.md");
    expect(readFileSync(join(dataDir(), "memory", "user", "prefers-pnpm.md"), "utf8")).toContain(
      "CI 也用。",
    );
    expect(await ama(["edit", "prefers-pnpm"], edit("\nsk-abcdefghijklmnopqrstuvwx"))).toBe(1);
    expect(err.join("")).toContain("看起来像凭据（API key），未保存。");
    out = [];
    expect(
      await ama(["edit", "--scope", "user"], {
        edit: async (text) => text.replace("name: ", "name: Lint Rules"),
      }),
    ).toBe(0);
    expect(out.join("")).toBe("已保存 /memories/user/lint-rules.md，下次会话起出现在索引。\n");
    expect(await ama(["edit", "prefers-pnpm"], { edit: async () => undefined })).toBe(0);
    expect(out.join("")).toContain("编辑器未保存退出，没有改动。");
  });

  it("enable / disable 改用户级 config.json 的 memory.enabled（保留其它键）", async () => {
    home.write("home/.config/ama/config.json", { version: 1, thinkingLevel: "high" });
    expect(await ama(["enable"])).toBe(0);
    const path = join(configDir(), "config.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      thinkingLevel: "high",
      memory: { enabled: true },
    });
    expect(out.join("")).toContain("已在");
    expect(await ama(["disable"])).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).memory).toEqual({ enabled: false });
    expect(existsSync(`${path}.bak`)).toBe(true);
  });

  it("没有 config.json 时 enable 写出合法的最小配置，之后各命令照常读", async () => {
    expect(await ama(["enable"])).toBe(0);
    const config = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"));
    expect(config.version).toBe(1);
    expect(config.memory).toEqual({ enabled: true });
    out = [];
    err = [];
    expect(await ama(["list"])).toBe(0);
    expect(err.join("")).not.toContain("memory.enabled 为 false");
  });
});
