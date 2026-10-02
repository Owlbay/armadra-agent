/**
 * 组装根里的 codemode：预设生效、内层调用经真实权限管线、缓存前缀逐字节稳定（设计 §5.5、§5.6、§9.1）。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  composeHarness,
  recordingHost,
  type ComposeHarness,
} from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model, TranscriptContext } from "../ai/types.js";
import type { HostApi } from "../host/types.js";
import { detectSandboxCapability } from "./capability.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

const anthropic = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } }).get(
  "anthropic",
)?.models[0] as Model;
const signal = new AbortController().signal;

function prefix(context: TranscriptContext): string {
  const body = buildAnthropicRequest(anthropic, context, { signal, cacheRetention: "short" }).body;
  return JSON.stringify({ system: body["system"], tools: body["tools"] }, (key, value: unknown) =>
    key === "cache_control" ? undefined : value,
  );
}

const PARALLEL = `const [readme, hits, files] = await Promise.all([
  tools.read({ path: "README.md" }),
  tools.grep({ pattern: "TODO" }),
  tools.glob({ pattern: "*.md" }),
]);
text("lines: " + readme.trim().split("\\n").length);
text("todo hits: " + hits.trim().split("\\n").length);
return "md files: " + files.trim().split("\\n").length;`;

const codemodeCall = (script: string): FakeResponse => ({
  steps: [{ toolCall: { name: "codemode", arguments: { script } } }],
});

function allowCodemode(harness: ComposeHarness, extra: Record<string, unknown> = {}): void {
  harness.home.write("home/.config/ama/config.json", {
    version: 1,
    permission: { allow: ["codemode"] },
    ...extra,
  });
}

describe("组装根里的 codemode", () => {
  it("codemode 预设：模型只见 codemode；脚本并行调三个内置工具，结果只含脚本输出", async () => {
    h = composeHarness([codemodeCall(PARALLEL), { text: "done" }]);
    allowCodemode(h);
    h.home.write("work/README.md", "# demo\nline 2\n");
    h.home.write("work/notes.md", "TODO one\nTODO two\n");
    const runtime = await h.boot(["--model", "fake/echo", "--tools-preset", "codemode"]);
    expect(runtime.session.getTools().map((t) => t.name)).toEqual(["codemode"]);
    await runtime.session.prompt("summarize");
    const sent = JSON.parse(prefix(h.fake.calls[0]!.context)) as { tools: { name: string }[] };
    expect(sent.tools.map((t) => t.name)).toEqual(["codemode"]);
    const results = runtime.session.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(String(results[0]?.content)).toMatch(
      /^Script completed in \d+\.\d\ds\n\nlines: 2\ntodo hits: 2\nmd files: 2$/,
    );
    await runtime.dispose();
  });

  it("内层 bash 在无人值守下被管线拒绝 → 脚本收到 Error，其余成功", async () => {
    h = composeHarness([
      codemodeCall(`const r = await Promise.allSettled([
        tools.bash({ command: "echo hi" }),
        tools.ls({}),
      ]);
      return r.map((x) => x.status).join(",") + " " + (r[0].reason?.message ?? "");`),
      { text: "done" },
    ]);
    allowCodemode(h);
    const runtime = await h.boot(["--model", "fake/echo", "-p", "x", "--tools-preset", "codemode"]);
    await runtime.session.prompt("go");
    const content = String(
      runtime.session.messages.find((m) => m.role === "toolResult")?.content ?? "",
    );
    expect(content).toMatch(/\n\nrejected,fulfilled \S/);
    await runtime.dispose();
  });

  it("缓存：连续回合前缀逐字节相同；宿主中途注册工具后 codemode 描述不变、脚本里可调用", async () => {
    const script: FakeResponse[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 3 === 0) script.push(codemodeCall(`return (await tools.ls({})).length > 0;`));
      script.push({ text: `answer ${i}` });
    }
    script.push(codemodeCall(`return await tools.canvas_note({ text: "hi" });`), { text: "end" });
    h = composeHarness(script);
    allowCodemode(h);
    const host = recordingHost(h.home);
    const runtime = await h.boot([
      "--model",
      "fake/echo",
      "--tools-preset",
      "codemode",
      "--host",
      host.path,
    ]);
    for (let i = 0; i < 20; i++) await runtime.session.prompt(`q${i}`);
    const first = prefix(h.fake.calls[0]!.context);
    expect(first).toContain("declare const tools");
    for (const call of h.fake.calls) expect(prefix(call.context)).toBe(first);

    const api = (globalThis as Record<string, unknown>)["__amaHostEventsApi"] as HostApi;
    api.tools.register({
      name: "canvas_note",
      description: "Post a note on the canvas.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      permission: "read",
      execute: async (input) => ({ content: `noted ${(input as { text: string }).text}` }),
    });
    await runtime.session.prompt("note");
    // only 模式：宿主工具不进活动集，codemode 描述（冻结）不变 → 前缀不变
    expect(runtime.session.getTools().map((t) => t.name)).toEqual(["codemode"]);
    expect(prefix(h.fake.calls.at(-1)!.context)).toBe(first);
    const last = runtime.session.messages.filter((m) => m.role === "toolResult").at(-1);
    expect(String(last?.content)).toMatch(/\n\nnoted hi$/);
    await runtime.dispose();
  });

  it("coordinator 预设显式 codemode on：脚本只能调活动集里的工具，tools.bash 不可用", async () => {
    h = composeHarness([
      codemodeCall(`const r = await Promise.allSettled([
        tools.bash({ command: "echo pwned > owned.txt" }),
        tools.write({ path: "x.txt", content: "x" }),
        tools.read({ path: "README.md" }),
      ]);
      return r.map((x) => x.status + ":" + (x.reason?.message ?? "")).join("|") + " " + ALL_TOOLS.join(",");`),
      { text: "done" },
    ]);
    allowCodemode(h, {
      tools: { preset: "coordinator" },
      codemode: { mode: "on" },
      permission: { allow: ["codemode", "bash", "write"] },
    });
    h.home.write("work/README.md", "# demo\n");
    const runtime = await h.boot(["--model", "fake/echo", "-p", "x"]);
    const tools = runtime.session.getTools();
    expect(tools.map((t) => t.name)).toEqual(["codemode", "read"]);
    const description = tools.find((t) => t.name === "codemode")?.description ?? "";
    expect(description).not.toMatch(/\bbash\(args/);
    expect(description).not.toContain("BashResult");
    await runtime.session.prompt("go");
    const content = String(
      runtime.session.messages.find((m) => m.role === "toolResult")?.content ?? "",
    );
    expect(content).toContain("rejected:Unknown tool bash");
    expect(content).toContain("rejected:Unknown tool write");
    expect(content).toMatch(/\|fulfilled:\S* read$/);
    expect(h.home.read("work/README.md")).toBe("# demo\n");
    expect(() => h.home.read("work/owned.txt")).toThrow();
    await runtime.dispose();
  });

  it("default 预设跟随预设：strict 运行时带 codemode；非 strict 不带，提示一次（每个配置目录）", async () => {
    h = composeHarness([{ text: "ok" }, { text: "ok" }, { text: "ok" }]);
    const strict = detectSandboxCapability("26.0.0");
    const on = await h.boot(["--model", "fake/echo", "-p", "x"], { sandboxCapability: strict });
    expect(on.session.getTools().map((t) => t.name)).toContain("codemode");
    expect(on.warnings.join("\n")).not.toContain("codemode 缺省关闭");
    await on.dispose();
    // -p / RPC 的 stderr 常被脚本解析：一次性提示只在交互 / 行式界面出现，也不消耗「已提示」记录
    const quiet = await h.boot(["--model", "fake/echo", "-p", "x"]);
    expect(quiet.session.getTools().map((t) => t.name)).not.toContain("codemode");
    expect(quiet.warnings.join("\n")).not.toContain("codemode 缺省关闭");

    const off = await h.boot(["--model", "fake/echo", "--no-tui"]);
    expect(off.session.getTools().map((t) => t.name)).not.toContain("codemode");
    expect(off.warnings.filter((w) => w.includes("codemode 缺省关闭"))).toHaveLength(1);
    expect(off.warnings.join("\n")).toContain("Node 24 < 25");
    await off.dispose();
    const again = await h.boot(["--model", "fake/echo", "--no-tui"]);
    expect(again.warnings.join("\n")).not.toContain("codemode 缺省关闭");
    await again.dispose();
    // 显式写了 codemode.mode（含 off）不提示
    h.home.write("home/.config/ama/config.json", { version: 1, codemode: { mode: "off" } });
    h.home.write("home/.local/share/ama/notices.json", "{}");
    const explicit = await h.boot(["--model", "fake/echo", "-p", "x"]);
    expect(explicit.warnings.join("\n")).not.toContain("codemode 缺省关闭");
    await explicit.dispose();
  });

  it("--codemode on：codemode 与预设工具并列，其它工具描述不变，codemode 描述只列名字", async () => {
    h = composeHarness([{ text: "ok" }]);
    const runtime = await h.boot(["--model", "fake/echo", "--codemode", "on"]);
    const tools = runtime.session.getTools();
    expect(tools.map((t) => t.name)).toEqual([
      "bash",
      "codemode",
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
    expect(tools.find((t) => t.name === "read")?.description).not.toContain("codemode");
    const codemode = tools.find((t) => t.name === "codemode")?.description ?? "";
    expect(codemode).toContain(
      "same arguments: bash, edit, glob, grep, read, write (tools.bash resolves to BashResult",
    );
    expect(codemode).toContain("Callable only from scripts: ls, task, task_ctl, todo.");
    expect(codemode).not.toContain("ls(args:");
    await runtime.dispose();
  });

  it("on 模式的前缀增量（系统提示 + 工具表，字符 / 4 估算）≤ 500 token；脚本里仍可调仅脚本工具", async () => {
    const strict = detectSandboxCapability("26.0.0");
    const measure = async (mode: string, script: FakeResponse[]) => {
      const harness = composeHarness(script);
      allowCodemode(harness);
      harness.home.write("work/README.md", "# demo\n");
      const runtime = await harness.boot(["--model", "fake/echo", "-p", "x", "--codemode", mode], {
        sandboxCapability: strict,
      });
      await runtime.session.prompt("hi");
      const tokens = Math.ceil(prefix(harness.fake.calls[0]!.context).length / 4);
      const results = runtime.session.messages.filter((m) => m.role === "toolResult");
      await runtime.dispose();
      harness.cleanup();
      return { tokens, results };
    };
    const off = await measure("off", [{ text: "ok" }]);
    const on = await measure("on", [
      codemodeCall(`return (await tools.ls({})).includes("README.md");`),
      { text: "ok" },
    ]);
    // 去重前约 1356（审计 2026-10），去重后约 390
    expect(on.tokens - off.tokens).toBeLessThanOrEqual(500);
    expect(on.tokens - off.tokens).toBeGreaterThan(200);
    expect(String(on.results[0]?.content)).toMatch(/\n\ntrue$/);
  });
});
