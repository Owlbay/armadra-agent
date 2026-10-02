import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness } from "../agent/testing/harness.js";
import { stubHooks, stubPermission, stubTool } from "../agent/testing/stubs.js";
import type { SessionEvent } from "../agent/types.js";
import { builtinTools } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import { sandboxEntryForTests } from "../../test/helpers/codemode-sandbox.js";
import { detectSandboxCapability } from "./capability.js";
import { STORE_CUSTOM_TYPE } from "./store.js";
import {
  CODEMODE_ONLY_GUIDELINE,
  buildCodemodeDescription,
  codemodeToolFactory,
  createCodemodeTool,
  formatCodemodeResult,
  scriptErrorHint,
  toScriptValue,
} from "./tool.js";

const strict = detectSandboxCapability("26.0.0");
const loose = detectSandboxCapability("24.0.0");

function fixture(extra: { tools?: ToolDefinition[] } = {}) {
  const others: ToolDefinition[] = extra.tools ?? [
    stubTool({
      name: "read",
      properties: { path: { type: "string" } },
      required: ["path"],
      run: (input) => ({ content: `<${String(input["path"])}>` }),
    }) as ToolDefinition,
    stubTool({ name: "grep", run: () => ({ content: "g1\ng2" }) }) as ToolDefinition,
    stubTool({ name: "glob", run: () => ({ content: "a.md" }) }) as ToolDefinition,
    stubTool({ name: "bash", permission: "execute" }) as ToolDefinition,
  ];
  const codemode = createCodemodeTool({
    listTools: () => others.map((tool) => ({ tool, textResult: true })),
    capability: strict,
    entry: sandboxEntryForTests(),
  }) as ToolDefinition;
  return { codemode, tools: [codemode, ...others] };
}

const call = (script: string, id = "cm1") => ({
  toolCalls: [{ name: "codemode", args: { script }, id }],
});

function toolResults(h: ReturnType<typeof createHarness>) {
  return h.session.messages.filter((m) => m.role === "toolResult");
}

describe("codemode 工具（会话内）", () => {
  it("脚本并行调三个工具：只回脚本输出；内层事件带 parentToolCallId；Hook 输入 viaCodemode", async () => {
    const hooks = stubHooks({ PreToolUse: () => undefined });
    const { tools } = fixture();
    const h = createHarness({
      script: [
        call(`const [a, b, c] = await Promise.all([
          tools.read({ path: "x.ts" }),
          tools.grep({}),
          tools.glob({}),
        ]);
        return \`\${a} \${b.split("\\n").length} \${c}\`;`),
        { text: "done" },
      ],
      tools,
      activeTools: ["codemode"],
      hooks,
    });
    await h.session.prompt("go");
    const results = toolResults(h);
    expect(results).toHaveLength(1);
    expect(String(results[0]?.content)).toMatch(
      /^Script completed in \d+\.\d\ds\n\n<x\.ts> 2 a\.md$/,
    );
    expect(results[0]?.isError).toBe(false);
    const nested = h.events.filter(
      (e): e is Extract<SessionEvent, { type: "tool_execution_end" }> =>
        e.type === "tool_execution_end" && e.parentToolCallId === "cm1",
    );
    expect(nested.map((e) => e.toolName).sort()).toEqual(["glob", "grep", "read"]);
    const pre = hooks.calls.filter((c) => c.event === "PreToolUse").map((c) => c.payload);
    expect(pre[0]).toMatchObject({ toolName: "codemode" });
    expect(pre[0]?.viaCodemode).toBeUndefined();
    expect(pre.slice(1).every((p) => p.viaCodemode === true && p.parentToolCallId === "cm1")).toBe(
      true,
    );
    // 内层调用不入转录：模型下一次请求只多了 codemode 的一条结果
    const second = h.scripted.calls[1]?.context.messages ?? [];
    expect(second.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("tool_execution_update 透传脚本输出", async () => {
    const { tools } = fixture();
    const h = createHarness({
      script: [call(`text("one"); text("two");`), { text: "done" }],
      tools,
      activeTools: ["codemode"],
    });
    await h.session.prompt("go");
    const updates = h.events
      .filter(
        (e): e is Extract<SessionEvent, { type: "tool_execution_update" }> =>
          e.type === "tool_execution_update" && e.toolCallId === "cm1",
      )
      .map((e) => e.partial);
    expect(updates).toEqual(["one", "one\ntwo"]);
  });

  it("内层被 deny 规则拦下 → 脚本收到 Error，allSettled 其余成功", async () => {
    const { tools } = fixture();
    const h = createHarness({
      script: [
        call(`const r = await Promise.allSettled([tools.bash({}), tools.read({ path: "ok" })]);
        return r.map((x) => x.status === "fulfilled" ? x.value : x.reason.message).join(" | ");`),
        { text: "done" },
      ],
      tools,
      activeTools: ["codemode"],
      permission: stubPermission((input) =>
        input.toolName === "bash"
          ? { decision: "deny", step: "deny-rule", message: "Denied by rule bash(*)" }
          : undefined,
      ),
    });
    await h.session.prompt("go");
    expect(String(toolResults(h)[0]?.content)).toMatch(/\n\nDenied by rule bash\(\*\) \| <ok>$/);
  });

  it("Script failed 保留已产出输出与错误；脚本内不能调 codemode", async () => {
    const { tools } = fixture();
    const h = createHarness({
      script: [
        call(`text("partial");
await tools.codemode({ script: "1" }).catch((e) => text(e.message));
throw new Error("boom");`),
        { text: "done" },
      ],
      tools,
      activeTools: ["codemode"],
    });
    await h.session.prompt("go");
    const result = toolResults(h)[0];
    expect(result?.isError).toBe(true);
    expect(String(result?.content)).toMatch(
      /^Script failed in \d+\.\d\ds\n\npartial\ncodemode cannot be called from a codemode script\n\nScript error: Error: boom \(line 3\)$/,
    );
  });

  it("脚本里 require / 直接调工具名：失败原因后补正确写法", async () => {
    const { tools } = fixture();
    const h = createHarness({
      script: [
        call(`const fs = require("fs");`, "c1"),
        call(`return await read({ path: "x" });`, "c2"),
        { text: "done" },
      ],
      tools,
      activeTools: ["codemode"],
    });
    await h.session.prompt("go");
    const [first, second] = toolResults(h).map((m) => String(m.content));
    expect(first).toContain("ReferenceError: require is not defined");
    expect(first).toContain("Only tools.<name>(args) is available in codemode scripts");
    expect(second).toContain("Call tools as tools.read({...}), not read(...).");
  });

  it("非法 @options → 错误结果，不起子进程", async () => {
    const { codemode } = fixture();
    const h = createHarness({
      script: [call(`// @options: {"timeout_ms": -1}\nreturn 1`), { text: "done" }],
      tools: [codemode],
    });
    await h.session.prompt("go");
    expect(String(toolResults(h)[0]?.content)).toMatch(/timeout_ms must be an integer/);
  });

  it("store：成功才提交，下一次脚本 load 到；失败的脚本不写", async () => {
    const { tools } = fixture();
    const h = createHarness({
      script: [
        call(`store("n", (load("n") ?? 0) + 1); return load("n");`, "c1"),
        call(`store("n", 100); throw new Error("x");`, "c2"),
        call(`return load("n");`, "c3"),
        { text: "done" },
      ],
      tools,
      activeTools: ["codemode"],
    });
    await h.session.prompt("go");
    const texts = toolResults(h).map((m) => String(m.content).split("\n\n")[1]);
    expect(texts).toEqual(["1", "(no output)", "1"]);
    const customs = h.manager.entries().filter((e) => e.type === "custom");
    expect(customs).toHaveLength(1);
    expect(customs[0]).toMatchObject({
      customType: STORE_CUSTOM_TYPE,
      data: { entries: { n: 1 } },
    });
  });
});

describe("描述与缓存稳定", () => {
  it("描述含工具声明，第一次读取后冻结（之后新增的工具不改变描述）", () => {
    const list = [{ tool: stubTool({ name: "read" }) as ToolDefinition, textResult: true }];
    const tool = createCodemodeTool({ listTools: () => list, capability: strict });
    const first = tool.description;
    expect(first).toContain("read(args: Record<string, unknown>): Promise<string>;");
    expect(first).toContain("declare const tools");
    list.push({ tool: stubTool({ name: "canvas_send" }) as ToolDefinition, textResult: false });
    expect(tool.description).toBe(first);
    expect(tool.description).not.toContain("canvas_send");
  });

  it("同样的工具 → 字节相同；内置工具全部内联", () => {
    const list = builtinTools().map((tool) => ({ tool, textResult: true }));
    const a = buildCodemodeDescription(list, 3000, strict);
    const b = buildCodemodeDescription([...list].reverse(), 3000, strict);
    expect(a).toBe(b);
    for (const name of ["bash", "edit", "glob", "grep", "ls", "read", "task", "todo", "write"]) {
      expect(a).toContain(`\n  ${name}(args:`);
    }
    expect(a).not.toContain("Sandbox:");
  });

  it("Node 22 / 24：描述标注网络未隔离（两种写法都标）", () => {
    const read = stubTool({ name: "read" }) as ToolDefinition;
    const list = [{ tool: read, textResult: true, direct: true }];
    expect(buildCodemodeDescription(list, 3000, loose)).toContain(
      "Sandbox: Node 24: network not isolated",
    );
    expect(buildCodemodeDescription(list, 3000, loose, "on")).toContain(
      "Sandbox: Node 24: network not isolated",
    );
  });

  it("on 写法：直接工具与仅脚本工具都只列名字，不内联声明；bash 可调时带 BashResult", () => {
    const list = builtinTools().map((tool) => ({
      tool,
      textResult: true,
      direct: ["bash", "edit", "glob", "grep", "read", "write"].includes(tool.name),
    }));
    const text = buildCodemodeDescription(list, 3000, strict, "on");
    expect(text).toContain(
      "Your direct tools are callable here too, same arguments: bash, edit, glob, grep, read, write (tools.bash resolves to BashResult; the others to text).",
    );
    expect(text).toContain("interface BashResult");
    expect(text).toContain("Callable only from scripts: ls, task, todo.");
    expect(text).not.toContain("declare const tools");
    expect(text).not.toMatch(/\b(bash|read|ls)\(args/);
    // 只依赖工具名：顺序无关、字节稳定
    expect(buildCodemodeDescription([...list].reverse(), 3000, strict, "on")).toBe(text);
    const readOnly = buildCodemodeDescription(
      [{ tool: stubTool({ name: "read" }) as ToolDefinition, textResult: true, direct: true }],
      3000,
      strict,
      "on",
    );
    expect(readOnly).toContain("same arguments: read.");
    expect(readOnly).not.toContain("BashResult");
    expect(readOnly).not.toContain("Callable only from scripts");
  });
});

describe("描述规则与权限类", () => {
  it("描述快照：规则段 + 6 行示例 + 内置工具声明", () => {
    const list = builtinTools().map((tool) => ({ tool, textResult: true }));
    const text = buildCodemodeDescription(list, 3000, strict);
    expect(text.split("\n").slice(0, 11).join("\n")).toMatchSnapshot();
    expect(text).toContain(
      "Only tools.<name>(args) is available. There is no require, import, process, fetch or timers; do not call tools directly as functions.",
    );
  });

  it("权限类随沙箱能力：网络隔离 read，未隔离 execute", () => {
    const listTools = () => [];
    expect(createCodemodeTool({ listTools, capability: strict }).permission).toBe("read");
    expect(createCodemodeTool({ listTools, capability: loose }).permission).toBe("execute");
  });

  it("scriptErrorHint：import / 动态 import / process / 工具名；其它原样", () => {
    const names = ["read", "bash"];
    const only = "Only tools.<name>(args) is available";
    expect(
      scriptErrorHint("SyntaxError: Cannot use import statement outside a module", names),
    ).toContain(only);
    expect(
      scriptErrorHint("TypeError: A dynamic import callback was not specified.", names),
    ).toContain(only);
    expect(scriptErrorHint("ReferenceError: process is not defined (line 2)", names)).toContain(
      only,
    );
    expect(scriptErrorHint("ReferenceError: bash is not defined", names)).toContain(
      "tools.bash({...})",
    );
    expect(scriptErrorHint("ReferenceError: foo is not defined", names)).toBe(
      "ReferenceError: foo is not defined",
    );
    expect(scriptErrorHint("Error: boom", names)).toBe("Error: boom");
  });
});

describe("工厂", () => {
  const registry = {
    list: () => ["codemode", "read"],
    get: (name: string) => (name === "read" ? (stubTool({ name }) as ToolDefinition) : undefined),
    sourceOf: () => "builtin",
  };

  it("off 不注册；跟随预设：default 只在 strict 时注册，codemode-only 总注册；显式 on 注册", () => {
    const warnings: string[] = [];
    const factory = codemodeToolFactory({ capability: strict });
    const nonStrict = codemodeToolFactory({ capability: loose });
    const ctx = (config: object) => ({ config, registry, warn: (m: string) => warnings.push(m) });
    expect(factory(ctx({}))?.name).toBe("codemode");
    expect(nonStrict(ctx({}))).toBeUndefined();
    expect(factory(ctx({ tools: { preset: "minimal" } }))).toBeUndefined();
    expect(factory(ctx({ tools: { preset: "coordinator" } }))).toBeUndefined();
    expect(
      factory(ctx({ codemode: { mode: "off" }, tools: { preset: "codemode" } })),
    ).toBeUndefined();
    expect(factory(ctx({ tools: { preset: "codemode" } }))?.name).toBe("codemode");
    expect(nonStrict(ctx({ tools: { preset: "codemode-only" } }))?.name).toBe("codemode");
    expect(factory(ctx({ codemode: { mode: "on" } }))?.description).toContain(
      "Callable only from scripts: read.",
    );
    expect(factory(ctx({ tools: { preset: "codemode" } }))?.description).toContain("read(args");
    expect(nonStrict(ctx({ codemode: { mode: "on" } }))?.permission).toBe("execute");
    expect(warnings).toEqual([]);
  });

  it("only 模式：系统提示的工具行与规则写明其它工具只能在脚本里调用；on 模式不加", () => {
    const factory = codemodeToolFactory({ capability: strict });
    const warn = () => undefined;
    const only = factory({ config: { tools: { preset: "codemode" } }, registry, warn });
    expect(only?.promptSnippet).toContain("your only tool");
    expect(only?.promptGuidelines).toEqual([CODEMODE_ONLY_GUIDELINE]);
    const on = factory({ config: { codemode: { mode: "on" } }, registry, warn });
    expect(on?.promptSnippet).not.toContain("only tool");
    expect(on?.promptGuidelines).toBeUndefined();
  });

  it("requireStrict 而运行时不隔离网络 → 不注册并 warning；不要求则可用", () => {
    const warnings: string[] = [];
    const factory = codemodeToolFactory({ capability: loose });
    const warn = (m: string) => warnings.push(m);
    expect(
      factory({ config: { codemode: { mode: "only", requireStrict: true } }, registry, warn }),
    ).toBeUndefined();
    expect(warnings[0]).toMatch(/codemode 已禁用/);
    expect(
      factory({ config: { codemode: { mode: "only" } }, registry, warn })?.description,
    ).toContain("network not isolated");
  });
});

describe("结果与返回值", () => {
  it("bash 解析为 { output, truncated, fullOutputPath?, exitCode, wallTimeMs }，非零退出码也解析", () => {
    const structured = {
      output: "out",
      exit_code: 2,
      truncated: true,
      full_output_path: "/tmp/f.txt",
      wall_time_seconds: 1.23,
    };
    expect(toScriptValue("bash", { content: "x", isError: true, structured })).toEqual({
      output: "out",
      truncated: true,
      fullOutputPath: "/tmp/f.txt",
      exitCode: 2,
      wallTimeMs: 1230,
    });
    expect(() => toScriptValue("bash", { content: "The user denied bash", isError: true })).toThrow(
      "The user denied bash",
    );
    expect(toScriptValue("read", { content: [{ type: "text", text: "a" }] })).toBe("a");
    expect(toScriptValue("canvas_x", { content: "t", structured: { k: 1 } })).toEqual({ k: 1 });
  });

  it("超过上限保留首尾，全文落盘", () => {
    let saved = "";
    const out = formatCodemodeResult(
      { ok: true, outputs: ["a".repeat(50), "b".repeat(50)], elapsedMs: 1234, droppedChars: 0 },
      40,
      (text) => {
        saved = text;
        return "/out/cm1.txt";
      },
    );
    expect(saved).toBe(`${"a".repeat(50)}\n${"b".repeat(50)}`);
    expect(out.fullOutputPath).toBe("/out/cm1.txt");
    expect(out.text).toBe(
      `Script completed in 1.23s\n\n${"a".repeat(20)}\n[... 61 characters omitted; full output: /out/cm1.txt ...]\n${"b".repeat(20)}`,
    );
  });

  it("会话里超限：全文写到 outputDir/<toolCallId>.txt", async () => {
    const { tools } = fixture();
    const dir = `${sandboxEntryForTests()}-out`;
    const h = createHarness({
      script: [
        call(`// @options: {"max_output_tokens": 300}\nreturn "z".repeat(5000)`),
        { text: "ok" },
      ],
      tools,
      activeTools: ["codemode"],
      outputDir: dir,
    });
    await h.session.prompt("go");
    const content = String(toolResults(h)[0]?.content);
    expect(content).toContain(`full output: ${join(dir, "cm1.txt")}`);
    expect(existsSync(join(dir, "cm1.txt"))).toBe(true);
    expect(readFileSync(join(dir, "cm1.txt"), "utf8")).toBe("z".repeat(5000));
    rmSync(dir, { recursive: true, force: true });
  });
});
