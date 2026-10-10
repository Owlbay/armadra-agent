/**
 * [W6-C0] 不再按中文字面量判断的三处（docs/history/wave6-plan.md §5.3、D19）：zh 输出字节不变，逻辑走枚举 / 码。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AgentInfo } from "../../agents/types.js";
import type { CodeRestoreResult } from "../../checkpoints/types.js";
import { setLocale } from "../../i18n/index.js";
import { PasteStore, formatMarker } from "../../tui/components/editor-paste.js";
import { codeResultText } from "./rewind-text.js";
import { agentFactItems, agentFacts } from "./tasks-report.js";

afterEach(() => setLocale("zh"));

describe("agent-panels：安装状态按 state 上色", () => {
  const base = { name: "codex", description: "", runner: "codex", source: "builtin" } as const;

  it("事实项带 state，文本与 agentFacts 相同", () => {
    const missing = { ...base, installed: false } as unknown as AgentInfo;
    expect(agentFactItems(missing).at(-1)).toEqual({ text: "未安装", state: "missing" });
    const installed = { ...base, installed: true, version: "1.2.3" } as unknown as AgentInfo;
    expect(agentFactItems(installed).at(-1)).toEqual({
      text: "已安装 1.2.3",
      state: "installed",
    });
    expect(agentFactItems(installed).map((f) => f.text)).toEqual(agentFacts(installed));
    expect(agentFactItems(base as unknown as AgentInfo).every((f) => f.state === undefined)).toBe(
      true,
    );
  });
});

describe("rewind-text：跳过原因按码分组", () => {
  const code = (over: Partial<CodeRestoreResult>): CodeRestoreResult => ({
    restored: ["a.ts"],
    deleted: [],
    conflicts: [],
    skipped: [],
    failed: [],
    insertions: 1,
    deletions: 0,
    ...over,
  });

  it("失败按码合并计数（明细带各自的错误信息）", () => {
    const text = codeResultText(
      code({
        failed: [
          { path: "x", message: "EACCES" },
          { path: "y", message: "ENOENT" },
        ],
        skipped: [{ path: "l", reason: "symlink" }],
        conflicts: ["c"],
      }),
    );
    expect(text).toContain("冲突 1、符号链接 1、失败 2");
  });
});

describe("editor-paste：标记按语言渲染、两种写法都认", () => {
  it("zh 与原来字节相同；en 用英文", () => {
    expect(formatMarker(1, 30)).toBe("[粘贴 #1 · 30 行]");
    setLocale("en");
    expect(formatMarker(1, 30)).toBe("[paste #1 · 30 lines]");
    expect(formatMarker(2, 1)).toBe("[paste #2 · 1 line]");
  });

  it("换语言后旧标记仍是不可分割段并能展开", () => {
    const store = new PasteStore();
    const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const zhMarker = store.accept(big);
    setLocale("en");
    const enMarker = store.accept(big);
    expect(zhMarker).toBe("[粘贴 #1 · 12 行]");
    expect(enMarker).toBe("[paste #2 · 12 lines]");
    const line = `a ${zhMarker} b ${enMarker}`;
    expect(store.ranges(line)).toHaveLength(2);
    expect(store.expand(line)).toBe(`a ${big} b ${big}`);
  });
});
