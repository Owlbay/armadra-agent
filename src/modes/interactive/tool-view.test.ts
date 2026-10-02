import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    expect(toolSummary("grep", { pattern: "TODO", path: "/w/src" }, "/w")).toBe("TODO  in src");
    expect(toolSummary("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolSummary("task", { description: "查用法", prompt: "..." })).toBe("查用法");
    expect(toolSummary("canvas_read", { query: "节点" })).toBe("节点");
    expect(toolSummary("x", null)).toBe("");
  });

  it("折叠：结果前 3 行 + 剩余行数；展开显示全部；错误红色", () => {
    const view = new ToolView("1", "read", { path: "README.md" }, { theme });
    view.finish({ content: numbered(10) }, false);
    expect(lines(view)).toEqual([
      "● read  README.md",
      "  line 1",
      "  line 2",
      "  line 3",
      "  … 另 7 行（Ctrl+O 展开）",
    ]);
    view.setExpanded(true);
    expect(lines(view)).toHaveLength(11);
    const colored = new ToolView(
      "2",
      "bash",
      { command: "false" },
      {
        theme: createTheme("dark", { caps: { colors: 256 } }),
      },
    );
    colored.finish({ content: "boom", isError: true }, true);
    expect(colored.render(40)[1]).toContain("\x1b[38;5;");
  });

  it("bash 运行中流式显示尾部 8 行，结束后换成结果", () => {
    const view = new ToolView("1", "bash", { command: "make" }, { theme });
    view.update(numbered(20, "out"));
    const running = lines(view);
    expect(running).toHaveLength(9);
    expect(running[1]).toBe("  out 13");
    expect(running[8]).toBe("  out 20");
    view.finish({ content: "done\n" }, false);
    expect(lines(view)).toEqual(["● bash  make", "  done"]);
  });

  it("edit：显示 details.diff（去掉文件头），折叠 12 行", () => {
    const diff = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n");
    const view = new ToolView("1", "edit", { path: "x" }, { theme });
    view.finish({ content: "Edited x", details: { diff } }, false);
    expect(lines(view)).toEqual(["● edit  x", "  @@ -1,2 +1,2 @@", "   keep", "  -old", "  +new"]);
    const big = new ToolView("2", "edit", { path: "y" }, { theme });
    big.finish({ content: "", details: { diff: numbered(30, "+l") } }, false);
    expect(lines(big).at(-1)).toBe("  … 另 18 行（Ctrl+O 展开）");
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
      "● codemode  x",
      "  … 前 2 个调用",
      "  ● read  f3.ts",
      "  ● read  f4.ts",
      "  ● read  f5.ts",
      "  ● read  f6.ts",
      "  ● read  f7.ts",
      "  result",
    ]);
    expect(tracker.toggleExpanded()).toBe(true);
    const expanded = lines(outer.view);
    expect(expanded).toContain("  ● read  f1.ts");
    expect(expanded).toContain("    body 1");
    // 已存在的 id 再 start 不重复建
    expect(tracker.start({ toolCallId: "cm", toolName: "codemode", args: {} }).view).toBe(
      outer.view,
    );
  });

  it("Ctrl+O 状态对之后的新调用也生效；completed 重放已完成的调用", () => {
    const tracker = new ToolTracker({ theme });
    tracker.toggleExpanded();
    const view = tracker.completed("r1", "read", { path: "a" }, { content: numbered(5) }, false);
    expect(view.isExpanded).toBe(true);
    expect(lines(view)).toHaveLength(6);
    tracker.update("r1", "ignored after finish");
    tracker.clear();
    expect(tracker.get("r1")).toBeUndefined();
  });
});
