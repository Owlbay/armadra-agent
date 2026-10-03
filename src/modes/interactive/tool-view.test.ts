import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../tools/types.js";
import { createTheme, plainTheme } from "../../tui.js";
import { ToolTracker, ToolView, cleanLines, toolSummary } from "./tool-view.js";
import { lines } from "./test-support.js";

const theme = plainTheme();
const numbered = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("工具视图", () => {
  it("标题摘要：bash 命令、相对路径与区间、搜索模式、task 描述、通用字段", () => {
    expect(toolSummary("bash", { command: "git status\n  && ls" })).toBe("git status ⏎ && ls");
    expect(toolSummary("read", { path: "/w/src/a.ts", offset: 10, limit: 20 }, "/w")).toBe(
      `${join("src", "a.ts")}:10+20`,
    );
    expect(toolSummary("read", { path: "/other/a.ts" }, "/w")).toBe("/other/a.ts");
    expect(toolSummary("grep", { pattern: "TODO", path: "/w/src" }, "/w")).toBe("TODO in src");
    expect(toolSummary("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolSummary("task", { description: "查用法", prompt: "..." })).toBe("查用法");
    expect(toolSummary("canvas_read", { query: "节点" })).toBe("节点");
    expect(toolSummary("x", null)).toBe("");
  });

  it("折叠：结果前 3 行 + 剩余行数；展开显示全部；错误红色", () => {
    const view = new ToolView("1", "read", { path: "README.md" }, { theme });
    view.finish({ content: numbered(10) }, false);
    expect(lines(view)).toEqual([
      "⏺ read README.md",
      "  ⎿ 读取 10 行",
      "    line 1",
      "    line 2",
      "    line 3",
      "    … 另 7 行（Ctrl+O 展开）",
    ]);
    view.setExpanded(true);
    expect(lines(view)).toHaveLength(12);
    const colored = new ToolView(
      "2",
      "bash",
      { command: "false" },
      {
        theme: createTheme("dark", { caps: { colors: 256 }, ascii: false }),
      },
    );
    colored.finish({ content: "boom", isError: true }, true);
    expect(colored.render(40)[1]).toContain("\x1b[38;5;203m退出 1");
    const failed = new ToolView("3", "read", { path: "x" }, { theme });
    failed.finish({ content: "ENOENT: x\nstack 1", isError: true }, true);
    expect(lines(failed)).toEqual(["⏺ read x", "  ⎿ ✗ ENOENT: x", "    stack 1"]);
  });

  it("bash 运行中流式显示尾部 8 行，结束后换成结果", () => {
    let now = 0;
    let frame = "⠋";
    const view = new ToolView(
      "1",
      "bash",
      { command: "make" },
      { theme, now: () => now, spinner: () => frame },
    );
    view.update(numbered(20, "out"));
    now = 4_000;
    const running = lines(view);
    expect(running).toHaveLength(10);
    expect(running.slice(0, 3)).toEqual(["⏺ bash make", "  ⎿ ⠋ 运行中 · 4s", "    out 13"]);
    expect(running[9]).toBe("    out 20");
    frame = "⠙";
    view.tick();
    // 已有输出的调用不受审批影响
    view.setAwaiting(true);
    expect(lines(view)[1]).toBe("  ⎿ ⠙ 运行中 · 4s");
    expect(lines(view)[1]).toBe("  ⎿ ⠙ 运行中 · 4s");
    now = 6_100;
    view.finish(
      {
        content: "done\n\n[exit code: 0]",
        details: { output: "done\n", exit_code: 0, totalLines: 1 },
      },
      false,
    );
    expect(lines(view)).toEqual(["⏺ bash make", "  ⎿ 退出 0 · 6.1s · 1 行", "    done"]);
    const failed = new ToolView("2", "bash", { command: "git push" }, { theme, now: () => 0 });
    failed.replayed = true; // 重放的历史调用：耗时取 wall_time_seconds
    failed.finish(
      {
        content: "fatal\n\n[exit code: 128]",
        isError: true,
        details: {
          output: "fatal: refusing",
          exit_code: 128,
          totalLines: 1,
          wall_time_seconds: 0.3,
        },
      },
      true,
    );
    expect(lines(failed)).toEqual([
      "⏺ bash git push",
      "  ⎿ 退出 128 · 0.3s · 1 行",
      "    fatal: refusing",
    ]);
  });

  it("edit：显示 details.diff（去掉文件头），折叠 12 行", () => {
    const diff = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n");
    const view = new ToolView("1", "edit", { path: "x" }, { theme });
    view.finish({ content: "Edited x", details: { diff, replacements: 1 } }, false);
    expect(lines(view, 40)).toEqual([
      "⏺ edit x",
      "  ⎿ 1 处修改 · +1 −1",
      "    @@ -1,2 +1,2 @@",
      "     keep",
      "    -old",
      "    +new",
    ]);
    expect(lines(view, 60).slice(3)).toEqual(["      1  keep", "      2 -old", "      2 +new"]);
    const big = new ToolView("2", "edit", { path: "y" }, { theme });
    big.finish({ content: "", details: { diff: numbered(30, "+l") } }, false);
    expect(lines(big).at(-1)).toBe("    … 另 18 行（Ctrl+O 展开）");
  });

  it("输出清洗：ANSI、控制字符、Tab、CRLF 与末尾空行", () => {
    expect(cleanLines("\x1b[31mred\x1b[0m\tx\r\ny\x07\n\n")).toEqual(["red    x", "y"]);
  });

  it("嵌套：parentToolCallId 挂到外层下，折叠只列最近 5 个内层标题，展开完整显示", () => {
    const tracker = new ToolTracker({ theme });
    const outer = tracker.start({ toolCallId: "cm", toolName: "codemode", args: { code: "x" } });
    expect(outer.topLevel).toBe(true);
    for (let i = 1; i <= 7; i++) {
      const inner = tracker.start({
        toolCallId: `i${i}`,
        toolName: "read",
        args: { path: `f${i}.ts` },
        parentToolCallId: "cm",
      });
      expect(inner.topLevel).toBe(false);
      tracker.end(`i${i}`, { content: `body ${i}` }, false);
    }
    tracker.end("cm", { content: "result" }, false);
    expect(lines(outer.view)).toEqual([
      "⏺ codemode x",
      "  ⎿ 7 个内层调用 · 脚本输出 1 行",
      "    … 前 2 个调用",
      "    ⏺ read f3.ts",
      "      ⎿ 读取 1 行",
      "    ⏺ read f4.ts",
      "      ⎿ 读取 1 行",
      "    ⏺ read f5.ts",
      "      ⎿ 读取 1 行",
      "    ⏺ read f6.ts",
      "      ⎿ 读取 1 行",
      "    ⏺ read f7.ts",
      "      ⎿ 读取 1 行",
      "    result",
    ]);
    expect(tracker.toggleExpanded()).toBe(true);
    const expanded = lines(outer.view);
    expect(expanded).toContain("    ⏺ read f1.ts");
    expect(expanded).toContain("        body 1");
    // 运行中的 id 再 start 不重复建；已结束的同名 id（跨回合复用）另起一个视图
    const running = tracker.start({ toolCallId: "r", toolName: "read", args: {} });
    expect(tracker.start({ toolCallId: "r", toolName: "read", args: {} }).view).toBe(running.view);
    const again = tracker.start({ toolCallId: "cm", toolName: "edit", args: {} });
    expect(again.view).not.toBe(outer.view);
    expect(again.topLevel).toBe(true);
  });

  it("Ctrl+O 状态对之后的新调用也生效；completed 重放已完成的调用", () => {
    const tracker = new ToolTracker({ theme });
    tracker.toggleExpanded();
    const view = tracker.completed("r1", "read", { path: "a" }, { content: numbered(5) }, false);
    expect(view.isExpanded).toBe(true);
    expect(lines(view)).toHaveLength(7);
    tracker.update("r1", "ignored after finish");
    tracker.clear();
    expect(tracker.get("r1")).toBeUndefined();
  });
});

describe("工具视图：自定义渲染", () => {
  const define = (partial: Partial<ToolDefinition>): ToolDefinition =>
    ({
      name: "codemode",
      description: "",
      parameters: {},
      permission: "execute",
      execute: async () => ({ content: "" }),
      ...partial,
    }) as ToolDefinition;
  const codemode = define({
    renderCall: (input) => String((input as { script: string }).script).split("\n"),
    renderResult: (result, _width, expanded) =>
      expanded ? ["script ok", "line 2", "line 3"] : [`script ok (${String(result.content)})`],
  });
  const getTool = (name: string) => (name === "codemode" ? codemode : undefined);

  it("标题取 renderCall 首行（codemode 显示脚本首行）；结果用 renderResult，展开传 expanded", () => {
    const view = new ToolView(
      "1",
      "codemode",
      { script: "const a = await tools.read({ path: 'x' });\nreturn a;" },
      { theme, getTool },
    );
    view.finish({ content: "42" }, false);
    expect(lines(view)).toEqual([
      "⏺ codemode const a = await tools.read({ path: 'x' });",
      "  ⎿ 0 个内层调用 · 脚本输出 1 行",
      "    script ok (42)",
    ]);
    view.setExpanded(true);
    expect(lines(view)).toEqual([
      "⏺ codemode const a = await tools.read({ path: 'x' });",
      "  ⎿ 0 个内层调用 · 脚本输出 1 行",
      "    script ok",
      "    line 2",
      "    line 3",
    ]);
  });

  it("没有 getTool 时 codemode 摘要取 script；错误结果、抛错或空渲染回到缺省显示", () => {
    expect(toolSummary("codemode", { script: "return 1;\n// more" })).toBe("return 1; ⏎ // more");
    const failed = new ToolView("2", "codemode", { script: "throw 1" }, { theme, getTool });
    failed.finish({ content: "Script failed: 1", isError: true }, false);
    expect(lines(failed)).toEqual(["⏺ codemode throw 1", "  ⎿ ✗ Script failed: 1"]);
    const broken = define({
      renderCall: () => {
        throw new Error("boom");
      },
      renderResult: () => [],
    });
    const view = new ToolView("3", "codemode", { script: "x()" }, { theme, getTool: () => broken });
    view.finish({ content: "out" }, false);
    expect(lines(view)).toEqual(["⏺ codemode x()", "  ⎿ 0 个内层调用 · 脚本输出 1 行", "    out"]);
  });

  it("ToolTracker 把 getTool 交给嵌套视图；自定义行去控制字符并按宽截断", () => {
    const wide = define({
      name: "codemode",
      renderResult: () => ["\x1b[31mred\x1b[0m\tcell", "x".repeat(80)],
    });
    const tracker = new ToolTracker({ theme, getTool: () => wide });
    const { view } = tracker.start({
      toolCallId: "1",
      toolName: "codemode",
      args: { script: "s" },
    });
    tracker.end("1", { content: "" }, false);
    expect(lines(view, 20)).toEqual([
      "⏺ codemode s",
      "  ⎿ 0 个内层调用 · …",
      "    red    cell",
      `    ${"x".repeat(15)}…`,
    ]);
  });
});

describe("工具视图：结果摘要", () => {
  const done = (
    name: string,
    args: unknown,
    result: Parameters<ToolView["finish"]>[0],
    width = 60,
  ) => {
    const view = new ToolView("x", name, args, { theme, now: () => 0 });
    view.finish(result, result.isError === true);
    return lines(view, width);
  };

  it("grep / glob / write / task / 通用", () => {
    expect(
      done(
        "grep",
        { pattern: "x", path: "src" },
        {
          content: "src/a.ts:3: x\nsrc/b.ts:9: x",
          details: { matches: 14, files: 6 },
        },
      ),
    ).toEqual([
      "⏺ grep x in src",
      "  ⎿ 14 处匹配 · 6 个文件",
      "    src/a.ts:3: x",
      "    src/b.ts:9: x",
    ]);
    expect(
      done(
        "grep",
        { pattern: "x" },
        { content: "No matches found", details: { matches: 0, files: 0 } },
      )[1],
    ).toBe("  ⎿ 无匹配");
    expect(
      done(
        "grep",
        { pattern: "x", filesOnly: true },
        { content: "a.ts\nb.ts", details: { files: 2, filesOnly: true, limited: false } },
      )[1],
    ).toBe("  ⎿ 2 个文件");
    expect(done("glob", { pattern: "*" }, { content: "a\nb", details: { count: 42 } })[1]).toBe(
      "  ⎿ 42 个文件",
    );
    expect(
      done(
        "write",
        { path: "a", content: "1\n2\n3\n" },
        { content: "Created a", details: { created: true } },
      )[1],
    ).toBe("  ⎿ 新建 · 3 行");
    expect(
      done(
        "task",
        { description: "查" },
        { content: "结论", details: { usage: { input: 28_000, output: 4100 } } },
      )[1],
    ).toBe("  ⎿ 完成 · 0.0s · ↑28k ↓4.1k");
    expect(done("todo_x", {}, { content: "" })[1]).toBe("  ⎿ 完成");
    expect(done("ls", {}, { content: "a\nb" })[1]).toBe("  ⎿ 2 行输出");
  });

  it("read：图片、空文件、按 details 行区间计数", () => {
    expect(
      done("read", { path: "p.png" }, { content: "img", details: { mimeType: "image/png" } })[1],
    ).toBe("  ⎿ 图片 image/png");
    expect(
      done("read", { path: "e" }, { content: "(e is empty)", details: { totalLines: 0 } })[1],
    ).toBe("  ⎿ 空文件");
    expect(
      done(
        "read",
        { path: "a" },
        {
          content: "x\n\n[Showing lines 1-120]",
          details: { firstLine: 1, lastLine: 120, totalLines: 399 },
        },
      )[1],
    ).toBe("  ⎿ 读取 120 行");
  });

  it("task 运行中：子 Agent 摘要", () => {
    const view = new ToolView("t", "task", { description: "查" }, { theme, now: () => 65_000 });
    expect(lines(view)[1]).toBe("  ⎿ · 子 Agent · 运行中 0s");
  });

  it("审批打开时还没输出的调用显示等待确认，关闭后重新计时", () => {
    let now = 0;
    const view = new ToolView("w", "bash", { command: "ls" }, { theme, now: () => now });
    view.setAwaiting(true);
    now = 5_000;
    expect(lines(view)[1]).toBe("  ⎿ · 等待确认");
    view.setAwaiting(false);
    now = 6_000;
    expect(lines(view)[1]).toBe("  ⎿ · 运行中 · 1s");
    view.finish({ content: "a", details: { exit_code: 0, output: "a", totalLines: 1 } }, false);
    expect(lines(view)[1]).toBe("  ⎿ 退出 0 · 1.0s · 1 行");
  });
});
