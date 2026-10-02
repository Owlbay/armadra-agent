/**
 * 提示长度预算（设计 §9.1「前缀预算」）：按真实 Anthropic 请求体估算「系统提示 + 工具定义」的
 * token（字符 / 4），每个预设一档上限。超出即失败并打印明细（每节系统提示、每个工具描述与 schema
 * 的字符数），让修改者权衡：每个 token 都在每次请求的缓存前缀里。
 *
 * 空工作目录、无 AGENTS.md、无用户 Skill（只有内置 `ama-docs` 一条索引），与 `ama -p hi` 实测口径一致。
 */

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
): Promise<PromptBreakdown & { tools: readonly ToolDecl[] }> {
  h = composeHarness();
  const runtime = await h.boot(["--model", "fake/echo", "--tools-preset", preset], {
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
  return { ...result, tools: system.toolsAdded ?? [] };
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
