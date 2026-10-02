/**
 * [W6-I5] 收尾迁移的英文抽样：参数解析错误、`ama config show|path`、项目级配置收紧告警、profile 错误。
 * 其余测试缺省钉 zh（zh 断言与黄金字节不变），这里只看 en。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { restrictProjectConfig } from "../config/merge.js";
import { loadProfile } from "../config/profile.js";
import { setLocale } from "../i18n/index.js";
import { parseArgs } from "./args.js";
import type { CliIo } from "./deps.js";
import { defaultIo, main } from "./main.js";

const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
  setLocale("zh");
});

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected an error");
}

describe("参数解析错误（en）", () => {
  it("每条都是英文；三个会话参数冲突用 a, b and c", () => {
    setLocale("en");
    expect(errorOf(() => parseArgs(["--thinking", "max"]))).toBe(
      "--thinking must be one of off | minimal | low | medium | high | xhigh (got max)",
    );
    expect(errorOf(() => parseArgs(["-c", "--fork", "x", "--session-id", "y"]))).toBe(
      "--continue, --session-id and --fork cannot be used together",
    );
    expect(errorOf(() => parseArgs(["-c", "--fork", "x"]))).toBe(
      "--continue and --fork cannot be used together",
    );
    for (const argv of [
      ["-x"],
      ["--model"],
      ["--no-tui=1"],
      ["--max-turns", "0", "-p", "x"],
      ["--max-cost", "-1", "-p", "x"],
      ["--max-turns", "2"],
      ["--image", "a.png"],
      ["--no-stdin", "x"],
      ["-"],
      ["--api-key", "k"],
      ["--resume="],
      ["--tui-mode", "fullscreen"],
      ["--system-prompt-mode", "replace"],
      ["--trust", "--no-trust"],
      ["--no-session", "-c"],
      ["-p", "--mode", "rpc", "x"],
    ])
      expect(
        errorOf(() => parseArgs(argv)),
        argv.join(" "),
      ).not.toMatch(CJK);
  });
});

describe("ama config（en）", () => {
  function io(out: string[]): CliIo {
    return {
      ...defaultIo(),
      stdout: (t: string) => void out.push(t),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: { ...home!.env, AMA_LANG: "en" },
      cwd: home!.cwd,
      readStdin: async () => "",
    };
  }

  it("show / path / --help 全英文；path 的标签列对齐", async () => {
    home = createTmpHome();
    home.write("work/.ama/config.json", { version: 1, permission: { allow: ["bash(*)"] } });
    for (const argv of [
      ["config", "show"],
      ["config", "--help"],
    ]) {
      const out: string[] = [];
      expect(await main(argv, { io: io(out), processHooks: false })).toBe(0);
      expect(
        out
          .join("")
          .split("\n")
          .filter((l) => CJK.test(l)),
      ).toEqual([]);
    }
    const show: string[] = [];
    await main(["config", "show"], { io: io(show), processHooks: false });
    expect(show.join("")).toContain("Effective config (sources: default built-in");
    expect(show.join("")).toContain(
      "Warning: .ama/config.json: project level cannot add allow rules; ignoring bash(*)",
    );
    const path: string[] = [];
    await main(["config", "path"], { io: io(path), processHooks: false });
    const lines = path.join("").split("\n");
    const at = (label: string) => lines.find((l) => l.startsWith(label))?.indexOf("/") ?? -1;
    expect(at("Config directory")).toBeGreaterThan(0);
    expect(at("Data directory")).toBe(at("Config directory"));
    expect(at("Project")).toBe(at("Config directory"));
  });
});

describe("配置收紧告警与 profile（en）", () => {
  it("项目级被忽略的每一类都有英文告警", () => {
    setLocale("en");
    const { warnings } = restrictProjectConfig(
      {
        version: 1,
        compaction: { prune: true } as never,
        tools: { preset: "default", allow: ["x"] } as never,
        codemode: { mode: "on" },
        sandbox: { network: "allow" } as never,
        plan: { bash: "ask", other: 1 } as never,
        checkpoints: { mode: "on", maxFileBytes: 1e12, keep: 3 } as never,
        permission: {
          allow: ["bash(*)"],
          builtinDeny: [],
          autoModel: "x",
          autoSafeCommands: ["ls"],
          mode: "full-auto",
        } as never,
        providers: {},
      },
      "default",
      "p.json",
      "minimal",
    );
    expect(warnings.length).toBeGreaterThanOrEqual(12);
    for (const w of warnings) {
      expect(w).toMatch(/^p\.json: .*project level/);
      expect(w).not.toMatch(CJK);
    }
  });

  it("profile 不存在 / 相对路径", () => {
    home = createTmpHome();
    setLocale("en");
    expect(errorOf(() => loadProfile("missing.json", home!.cwd))).toMatch(/: file not found$/);
    home.write("work/p.json", { version: 1, instructions: ["rel.md"] });
    expect(errorOf(() => loadProfile("p.json", home!.cwd))).toMatch(
      /: paths in a profile must be absolute:\n {2}instructions: rel\.md$/,
    );
  });
});

describe("ama --help", () => {
  it("两种语言都列出第六波的参数与子命令", async () => {
    const { messagesFor } = await import("../i18n/index.js");
    for (const locale of ["en", "zh"] as const) {
      const text = messagesFor(locale).cli.help;
      for (const needle of [
        "--lang <zh|en>",
        "--memory / --no-memory",
        "ama auth login chatgpt",
        "ama auth logout|status [chatgpt]",
        "ama config get|set|unset <key>",
        "ama config list",
        "ama memory list|show|edit|rm|path|enable|disable",
        "ama sessions trace <id>",
      ])
        expect(text, `${locale}: ${needle}`).toContain(needle);
    }
  });
});
