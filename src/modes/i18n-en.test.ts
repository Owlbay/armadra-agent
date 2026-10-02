/**
 * [W6-I3] 其余模式与领域的英文界面抽样（docs/wave6-plan.md §9 W6-I3 验收）：`ama -p` 的 stderr、
 * `--output-format json` 的机器字段不随语言变、`ama doctor`、斜杠命令与 `/session`、RPC 错误。
 * 其余测试缺省钉 zh，zh 断言不在这里。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { defaultIo, main } from "../cli/main.js";
import type { CliIo } from "../cli/deps.js";
import { messagesFor, setLocale } from "../i18n/index.js";
import { BUILTIN_COMMANDS } from "./commands-core.js";
import { describeLimit, describeDenied } from "./print/print-mode.js";

const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;
const EN = { AMA_LANG: "en" };

let h: ComposeHarness | undefined;
let home: TmpHome | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
  home?.cleanup();
  home = undefined;
  setLocale("zh");
});

describe("ama -p（en）", () => {
  // composeHarness 走 runCli，不经 main() 的语言选择：这里直接定 en（AMA_LANG 也传给子环境）
  beforeEach(() => setLocale("en"));

  it("被拒汇总与放行办法是英文；json 的机器字段与 zh 相同", async () => {
    const writeCall = {
      steps: [{ toolCall: { name: "write", arguments: { path: "out.txt", content: "x" } } }],
    };
    h = composeHarness([writeCall, { text: "done" }], { env: EN });
    expect(await h.run(["-p", "w", "--model", "fake/echo"])).toBe(7);
    expect(h.stdout()).toBe("done\n");
    expect(h.stderr()).toMatch(/^ama: 1 tool call denied: write ×1 \(/);
    expect(h.stderr()).toContain("use --permission-mode auto-edit|auto or --allow <rule>");
    expect(h.stderr()).not.toMatch(CJK);
    h.cleanup();
    h = composeHarness([writeCall, { text: "done" }], { env: EN });
    expect(await h.run(["-p", "w", "--model", "fake/echo", "--output-format", "json"])).toBe(7);
    const result = JSON.parse(h.stdout().trim()) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(["text", "stopReason", "deniedTools"]),
    );
    expect(result["deniedTools"]).toEqual([
      { toolCallId: expect.any(String), toolName: "write", reason: expect.any(String) },
    ]);
  });

  it("重试行与回合上限是英文", async () => {
    h = composeHarness([{ error: { kind: "overloaded" } }, { text: "ok" }], { env: EN });
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stderr()).toMatch(/^ama: ↻ retry 1\/3 \(in 0s\): .+\n$/);
    h.cleanup();
    const readCall = { steps: [{ toolCall: { name: "read", arguments: { path: "n.txt" } } }] };
    h = composeHarness([readCall, readCall, { text: "x" }], { env: EN });
    h.home.write("work/n.txt", "x\n");
    expect(await h.run(["-p", "go", "--model", "fake/echo", "--max-turns", "1"])).toBe(8);
    expect(h.stderr()).toContain(
      "ama: reached the turn limit 1 (--max-turns / limits.maxTurns); run ended before finishing",
    );
  });

  it("没有提示：英文用法错误", async () => {
    h = composeHarness([], { env: EN });
    expect(await h.run(["-p", "--model", "fake/echo"])).toBe(2);
    expect(h.stderr()).toBe(messagesFor("en").print.print.needsPrompt);
  });

  it("单行文案：费用上限、复数", () => {
    setLocale("en");
    expect(describeLimit({ type: "limit_reached", kind: "cost", value: 1.2, limit: 1 })).toBe(
      "ama: reached the cost limit $1.00 (spent $1.20; --max-cost / limits.maxCostUsd); run ended before finishing",
    );
    expect(
      describeDenied([
        { toolCallId: "a", toolName: "bash", reason: "" },
        { toolCallId: "b", toolName: "bash", reason: "" },
        { toolCallId: "c", toolName: "write", reason: "" },
      ]),
    ).toMatch(/^ama: 3 tool calls denied: bash ×2, write ×1; /);
  });
});

describe("ama doctor（en）", () => {
  function io(env: Record<string, string>, out: string[]): CliIo {
    return {
      ...defaultIo(),
      stdout: (t: string) => void out.push(t),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: { ...home!.env, ...env },
      cwd: home!.cwd,
      readStdin: async () => "",
    };
  }

  it("全英文，显示界面语言与来源；zh 显示「界面语言」", async () => {
    home = createTmpHome();
    const out: string[] = [];
    expect(await main(["doctor"], { io: io(EN, out), processHooks: false })).toBe(0);
    const text = out.join("");
    expect(text).toContain("\nDirectories\n  Config directory: ");
    expect(text).toContain("\nTerminal\n  stdin TTY: no · stdout TTY: no");
    expect(text).toContain("  UI language: en (source AMA_LANG=en)");
    // [W6-I5] codemode 一行（describeCodemode）也已迁移：整份 doctor 输出不含汉字
    expect(text.split("\n").filter((line) => CJK.test(line))).toEqual([]);
    setLocale("zh");
    const zh: string[] = [];
    expect(await main(["doctor"], { io: io({ AMA_LANG: "zh" }, zh), processHooks: false })).toBe(0);
    expect(zh.join("")).toContain("  界面语言：zh（来源 AMA_LANG=zh）");
  });

  it("--lang 覆盖时来源写 --lang", async () => {
    home = createTmpHome();
    const out: string[] = [];
    const env = { AMA_LANG: "", LC_ALL: "", LC_MESSAGES: "", LANG: "zh_CN.UTF-8" };
    expect(await main(["--lang", "en", "doctor"], { io: io(env, out), processHooks: false })).toBe(
      0,
    );
    expect(out.join("")).toContain("  UI language: en (source --lang)");
  });
});

describe("斜杠命令与 /session（en）", () => {
  it("命令说明随语言（getter，不在 import 时定死）", () => {
    setLocale("en");
    const help = BUILTIN_COMMANDS.find((c) => c.name === "help");
    const fork = BUILTIN_COMMANDS.find((c) => c.name === "fork");
    expect(help?.description).toBe("List commands");
    expect(fork?.args).toBe("[entry id]");
    for (const c of BUILTIN_COMMANDS) expect(`${c.args ?? ""} ${c.description}`).not.toMatch(CJK);
    setLocale("zh");
    expect(help?.description).toBe("列出命令");
    expect(fork?.args).toBe("[条目 id]");
  });
});
