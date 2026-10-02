import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS } from "../commands-core.js";
import { Editor, plainTheme, type AutocompleteResult } from "../../tui.js";
import { InteractiveCompletion, fileScore } from "./completion.js";

let dir: string;
let now = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ama-complete-"));
  for (const [path, body] of [
    ["README.md", "#"],
    ["src/main.ts", ""],
    ["src/modes/interactive/tool-view.ts", ""],
    ["src/modes/print/print-mode.ts", ""],
    ["docs/tui.md", ""],
    ["dist/out.js", ""],
    [".gitignore", "dist/\n"],
  ] as const) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  now = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function provider() {
  return new InteractiveCompletion({
    commands: () => [...BUILTIN_COMMANDS, { name: "tree", description: "会话树" }],
    prompts: () => [{ name: "review" }],
    skills: () => [{ name: "pdf", description: "处理 PDF" }],
    cwd: () => dir,
    now: () => now,
  });
}

function ctx(text: string, force = false) {
  const lines = text.split("\n");
  const line = lines[lines.length - 1] ?? "";
  return { line, textBeforeCursor: line, text, force };
}

describe("补全", () => {
  it("/ 命令：前缀匹配排前，带参数说明；模板与 /skill:", () => {
    const p = provider();
    const result = p.getSuggestions(ctx("/mo")) as AutocompleteResult;
    expect(result.from).toBe(0);
    expect(result.items[0]).toEqual({
      value: "/model",
      label: "/model",
      description: "[provider/id]  切换模型",
    });
    const all = p.getSuggestions(ctx("/")) as AutocompleteResult;
    const values = all.items.map((i) => i.value);
    expect(values).toContain("/tree");
    expect(values).toContain("/review");
    expect(values).toContain("/skill:pdf");
    const skill = p.getSuggestions(ctx("/skill:p")) as AutocompleteResult;
    expect(skill.items).toEqual([
      { value: "/skill:pdf", label: "/skill:pdf", description: "处理 PDF" },
    ]);
    // 子串匹配排在前缀之后
    const sub = p.getSuggestions(ctx("/e")) as AutocompleteResult;
    expect(sub.items[0]?.value).toBe("/exit");
    expect(sub.items.map((i) => i.value)).toContain("/new");
  });

  it("/ 只在首行行首、且光标前没有空格时触发；无匹配返回 null", () => {
    const p = provider();
    expect(p.getSuggestions(ctx("/model anth"))).toBeNull();
    expect(p.getSuggestions(ctx("看看\n/mo"))).toBeNull();
    expect(p.getSuggestions(ctx("a /mo"))).toBeNull();
    expect(p.getSuggestions(ctx("/zzz"))).toBeNull();
  });

  it("@ 文件：尊重 .gitignore，文件名前缀优先、浅的优先，目录以 / 结尾", async () => {
    const p = provider();
    const result = await (p.getSuggestions(ctx("看下 @tool")) as Promise<AutocompleteResult>);
    expect(result.from).toBe("看下 ".length);
    expect(result.items[0]).toEqual({
      value: "@src/modes/interactive/tool-view.ts",
      label: "src/modes/interactive/tool-view.ts",
    });
    const empty = await p.files("");
    expect(empty.map((i) => i.label)).toContain("src/");
    expect(empty.map((i) => i.label)).not.toContain("dist/out.js");
    const md = await p.files("md");
    expect(md.map((i) => i.label).slice(0, 2)).toEqual(["README.md", "docs/tui.md"]);
    const glob = await p.files("src/**/*-mode.ts");
    expect(glob.map((i) => i.label)).toEqual(["src/modes/print/print-mode.ts"]);
    expect(await p.files("nothing-matches")).toEqual([]);
    expect(await (p.getSuggestions(ctx("x@y")) ?? null)).toBeNull();
  });

  it("文件表缓存 15 秒，过期后重新遍历", async () => {
    const p = provider();
    expect((await p.files("new-file")).length).toBe(0);
    writeFileSync(join(dir, "new-file.ts"), "");
    expect((await p.files("new-file")).length).toBe(0);
    now = 16_000;
    expect((await p.files("new-file")).map((i) => i.label)).toEqual(["new-file.ts"]);
  });

  it("接进编辑器：输入触发、Tab 接受；异步 @ 补全返回后列表出现", async () => {
    let renders = 0;
    const editor = new Editor({
      theme: plainTheme(),
      autocomplete: provider(),
      requestRender: () => renders++,
    });
    editor.focused = true;
    for (const ch of "/mod") editor.handleInput(ch);
    expect(editor.isCompletionOpen).toBe(true);
    editor.handleInput("\t");
    expect(editor.getText()).toBe("/model");
    editor.clear();
    for (const ch of "@READ") editor.handleInput(ch);
    await new Promise((r) => setTimeout(r, 20));
    expect(renders).toBeGreaterThan(0);
    expect(editor.isCompletionOpen).toBe(true);
    editor.handleInput("\t");
    expect(editor.getText()).toBe("@README.md");
  });

  it("fileScore 分级", () => {
    expect(fileScore("src/tui.ts", "tui")).toBe(0);
    expect(fileScore("src/tui.ts", "src/t")).toBe(1);
    expect(fileScore("src/my-tui.ts", "tui")).toBe(2);
    expect(fileScore("tui/a.ts", "ui/")).toBe(3);
    expect(fileScore("a.ts", "zz")).toBeUndefined();
  });
});
