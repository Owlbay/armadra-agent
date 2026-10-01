/**
 * 工具测试用的 ToolContext 桩（B3 添加）。readFiles / custom 条目存在内存里；updates 收集 onUpdate。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../src/tools/types.js";

export interface TestToolContext extends ToolContext {
  readonly updates: string[];
  readonly customs: { customType: string; data: unknown }[];
  readonly logs: string[];
  readonly controller: AbortController;
}

export function makeToolContext(
  cwd: string,
  overrides: Partial<Omit<ToolContext, "readFiles">> = {},
): TestToolContext {
  const readFiles = new Set<string>();
  const updates: string[] = [];
  const customs: { customType: string; data: unknown }[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const ctx: TestToolContext = {
    toolCallId: "call_1",
    cwd,
    sessionId: "sess-test",
    signal: controller.signal,
    depth: 0,
    onUpdate: (partial) => updates.push(partial),
    readFiles,
    markRead: (p) => readFiles.add(p),
    tools: { executeTool: async () => ({ content: "", isError: true }) },
    session: {
      appendCustom: (customType, data) => customs.push({ customType, data }),
      lastCustom: (customType) =>
        [...customs].reverse().find((c) => c.customType === customType)?.data,
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    updates,
    customs,
    logs,
    controller,
    ...overrides,
  };
  return ctx;
}

/** 临时目录；返回路径与清理函数。 */
export function makeTmpDir(prefix = "ama-tools-"): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
