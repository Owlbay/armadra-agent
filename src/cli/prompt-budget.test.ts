/**
 * 提示长度预算（设计 §9.1「前缀预算」）：按真实 Anthropic 请求体估算「系统提示 + 工具定义」的
 * token（字符 / 4），每个预设一档上限。超出即失败并打印明细（每节系统提示、每个工具描述与 schema
 * 的字符数），让修改者权衡：每个 token 都在每次请求的缓存前缀里。
 *
 * 空工作目录、无 AGENTS.md、无用户 Skill（只有内置 `ama-docs` 一条索引），与 `ama -p hi` 实测口径一致。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import { detectSandboxCapability } from "../codemode/capability.js";
import type { Model, SystemMessage, ToolDecl } from "../ai/types.js";
import { resolveBashSandbox } from "../sandbox/bash.js";
import type { ComposeOptions } from "./compose.js";

let h: ComposeHarness | undefined;
afterEach(() => h?.cleanup());

const anthropic = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } }).get(
  "anthropic",
)?.models[0] as Model;
const signal = new AbortController().signal;
/** Node ≥ 25（沙箱 strict）：default 预设带 codemode，是最长的一档。 */
const STRICT = detectSandboxCapability("25.0.0", new Set(["--permission"]));

/** 上限（token，字符 / 4）。codemode-only 取实测当前值 +15%。 */
const PROMPT_BUDGETS = { default: 2000, minimal: 800, "codemode-only": 1775 } as const;
/** [W6-M] 记忆开启时 default 预设的上限（docs/wave6-plan.md §3.6、§10）。 */
const MEMORY_BUDGET = 2350;

interface PromptBreakdown {
  tokens: number;
  lines: string[];
}

const tok = (chars: number): number => Math.ceil(chars / 4);

/** 按请求体统计：system 块 + tools（去掉 cache_control）。 */
function measurePrompt(
  sections: Record<string, string>,
  tools: readonly ToolDecl[],
  body: Record<string, unknown>,
  normalize: (json: string) => string = (json) => json,
): PromptBreakdown {
  const strip = (value: unknown): string =>
    normalize(
      JSON.stringify(value ?? null, (key, v: unknown) => (key === "cache_control" ? undefined : v)),
    );
  const system = strip(body["system"]);
  const toolsJson = strip(body["tools"]);
  const lines = [`system ${system.length} chars`];
  for (const [name, text] of Object.entries(sections)) {
    lines.push(`  §${name} ${normalize(text).length}`);
  }
  lines.push(`tools ${toolsJson.length} chars`);
  for (const tool of tools) {
    const schema = JSON.stringify(tool.parameters).length;
    lines.push(`  ${tool.name}: description ${tool.description.length}, schema ${schema}`);
  }
  const tokens = tok(system.length + toolsJson.length);
  lines.push(`total ≈ ${tokens} tok`);
  return { tokens, lines };
}

async function measurePreset(
  preset: keyof typeof PROMPT_BUDGETS,
  extra: ComposeOptions = {},
  argv: readonly string[] = [],
  prepare?: (harness: ComposeHarness) => void,
): Promise<
  PromptBreakdown & { tools: readonly ToolDecl[]; body: Record<string, unknown>; prefix: string }
> {
  h = composeHarness();
  prepare?.(h);
  const runtime = await h.boot(["--model", "fake/echo", "--tools-preset", preset, ...argv], {
    sandboxCapability: STRICT,
    ...extra,
  });
  await runtime.session.prompt("hi");
  const context = h.fake.calls[0]!.context;
  const body = buildAnthropicRequest(anthropic, context, { signal, cacheRetention: "short" }).body;
  const system = runtime.session.entries.flatMap((e) =>
    e.type === "message" && e.message.role === "system" ? [e.message as SystemMessage] : [],
  )[0]!;
  const sections = Object.fromEntries(
    Object.entries(system.sections).filter((e): e is [string, string] => e[1] !== null),
  );
  // 临时目录的路径长度随平台变：换成典型长度的固定路径再计数（cwd 在 HOME 之外，先换）。
  const escaped = (path: string): string => JSON.stringify(path).slice(1, -1);
  const normalize = (json: string): string =>
    json
      .split(escaped(h!.home.cwd))
      .join("/home/user/project")
      .split(escaped(h!.home.home))
      .join("/home/user");
  const result = measurePrompt(sections, system.toolsAdded ?? [], body, normalize);
  await runtime.dispose();
  const prefix = normalize(JSON.stringify({ system: body["system"], tools: body["tools"] }));
  return { ...result, tools: system.toolsAdded ?? [], body, prefix };
}

describe("提示长度预算（字符 / 4 估算）", () => {
  for (const preset of Object.keys(PROMPT_BUDGETS) as (keyof typeof PROMPT_BUDGETS)[]) {
    it(`${preset} 预设：系统提示 + 工具定义 ≤ ${PROMPT_BUDGETS[preset]} tok`, async () => {
      const { tokens, lines } = await measurePreset(preset);
      const report = [`[${preset}] budget ${PROMPT_BUDGETS[preset]} tok`, ...lines].join("\n");
      if (process.env["AMA_PROMPT_BUDGET_REPORT"] === "1") console.log(report);
      if (tokens > PROMPT_BUDGETS[preset]) {
        console.error(
          `${report}\n系统提示 + 工具定义超出预算：每次请求都带着它们。精简描述，或把说明挪进 Skill / 按需加载的位置；确需放宽时改 PROMPT_BUDGETS 并在 PR 写明理由。`,
        );
      }
      expect(tokens, report).toBeLessThanOrEqual(PROMPT_BUDGETS[preset]);
    });
  }

  it("[S2] bash 沙箱生效时（工具多一个参数与一句描述）default 预设仍在预算内", async () => {
    const bashSandbox = resolveBashSandbox(
      { bash: "auto" },
      {
        status: {
          kind: "sandbox-exec",
          path: "/usr/bin/sandbox-exec",
          isolatesNetwork: true,
          restrictsWrites: true,
          detail: "fake",
        },
      },
    );
    const { tokens, lines, tools } = await measurePreset("default", { bashSandbox });
    const bash = tools.find((t) => t.name === "bash");
    expect(JSON.stringify(bash?.parameters)).toContain('"sandbox"');
    expect(tokens, lines.join("\n")).toBeLessThanOrEqual(PROMPT_BUDGETS.default);
  });

  it(`[W6-M] default+memory（空索引，user + project）≤ ${MEMORY_BUDGET} tok`, async () => {
    const { tokens, lines, tools, body } = await measurePreset("default", {}, [
      "--memory",
      "--trust",
    ]);
    const report = [`[default+memory] budget ${MEMORY_BUDGET} tok`, ...lines].join("\n");
    if (process.env["AMA_PROMPT_BUDGET_REPORT"] === "1") console.log(report);
    expect(tools.map((t) => t.name)).toContain("memory");
    const system = JSON.stringify(body["system"]);
    expect(system).toContain('<scope name=\\"user\\">(empty)</scope>');
    expect(system).toContain('<scope name=\\"project\\">(empty)</scope>');
    expect(tokens, report).toBeLessThanOrEqual(MEMORY_BUDGET);
  });

  it("[W6-M] 记忆关闭（缺省 / --no-memory）与 default 的 system + tools 逐字节相同，且不建记忆目录", async () => {
    const noMemoryDir = (): boolean =>
      !existsSync(join(h!.home.env["AMA_DATA_DIR"] ?? "", "memory"));
    const base = await measurePreset("default", { sandboxCapability: STRICT });
    expect(noMemoryDir()).toBe(true);
    h?.cleanup();
    const off = await measurePreset("default", { sandboxCapability: STRICT }, ["--no-memory"]);
    expect(noMemoryDir()).toBe(true);
    expect(off.prefix).toBe(base.prefix);
    expect(off.tokens).toBe(base.tokens);
  });

  it("[W7-B1] default + task：交互（line）用后台版描述、-p 用前台版，两者都在 default 预算内", async () => {
    // task 不在 default 预设里：按用户配置加上（`tools.default: ["+task"]`）再量
    const withTask = (harness: ComposeHarness) =>
      harness.home.write("home/.config/ama/config.json", {
        version: 1,
        tools: { default: ["+task"] },
      });
    const line = await measurePreset("default", {}, [], withTask);
    const taskOf = (tools: readonly ToolDecl[]) => tools.find((t) => t.name === "task");
    expect(taskOf(line.tools)?.description).toContain("Runs in the background by default");
    expect(JSON.stringify(line.body["system"])).toContain("never sleep or poll for it");
    h?.cleanup();
    const print = await measurePreset("default", {}, ["-p"], withTask);
    expect(taskOf(print.tools)?.description).toContain("Returns its final report.");
    expect(print.tokens).toBeLessThanOrEqual(PROMPT_BUDGETS.default);
    expect(line.tokens).toBeLessThanOrEqual(PROMPT_BUDGETS.default);
  });

  it("[W7-B1] 缓存前缀：同一会话前后两次请求的 system + tools 逐字节相同", async () => {
    h = composeHarness();
    const runtime = await h.boot(["--model", "fake/echo", "--tools-preset", "default"], {
      sandboxCapability: STRICT,
    });
    await runtime.session.prompt("hi");
    await runtime.session.prompt("again");
    const prefix = (i: number) => {
      const body = buildAnthropicRequest(anthropic, h!.fake.calls[i]!.context, {
        signal,
        cacheRetention: "short",
      }).body;
      return JSON.stringify({ system: body["system"], tools: body["tools"] });
    };
    expect(h.fake.calls.length).toBeGreaterThanOrEqual(2);
    expect(prefix(h.fake.calls.length - 1)).toBe(prefix(0));
    await runtime.dispose();
  });

  it("超出预算会失败并给出逐项明细", () => {
    const long = "x".repeat(4 * 900);
    const tools: ToolDecl[] = [{ name: "fat", description: long, parameters: { type: "object" } }];
    const body = {
      system: [{ type: "text", text: "p" }],
      tools: [{ name: "fat", description: long }],
    };
    const { tokens, lines } = measurePrompt({ preamble: "p" }, tools, body);
    expect(tokens).toBeGreaterThan(PROMPT_BUDGETS.minimal);
    expect(lines).toContain(`  fat: description ${long.length}, schema 17`);
  });
});
