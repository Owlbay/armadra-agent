/**
 * `memory` 工具（docs/history/wave6-plan.md §3.3、D10）。[W6-M] 模型侧模块：不得 import src/i18n。
 *
 * 自定义工具（不声明供应商原生的 memory 工具类型），四个命令：`view / create / str_replace / delete`，路径限定
 * 在 `/memories/<scope>/`。权限类 `memory`：view 按读放行，写命令按 execute 判定（permissions/memory-class.ts）。
 * 执行层额外拒绝：
 * - 子会话（depth > 0）：`memory.subagents: "read"` 拒绝写命令，`"off"` 连 view 也拒绝——工具定义与父会话
 *   一致，保住子会话首请求命中父前缀；
 * - `/memory off`：本会话禁止写；
 * - 凭据、大小、条数上限、路径越界（store.ts）。
 * 写入只落盘：结果提示「下次会话起出现在索引」，本会话的 `memory` 节不变（前缀稳定）。
 */

import type { ToolDefinition, ToolResult } from "../tools/types.js";
import { MemoryLockError } from "./lock.js";
import type { MemoryRuntime } from "./runtime.js";
import { MemoryError } from "./store.js";

export const MEMORY_TOOL = "memory";

export interface MemoryInput {
  command: "view" | "create" | "str_replace" | "delete";
  path: string;
  view_range?: number[];
  file_text?: string;
  old_str?: string;
  new_str?: string;
}

export const MEMORY_GUIDELINES: readonly string[] = [
  "memory: save only when the user asks you to remember something or states a durable preference or correction; never store secrets or facts that can be read from the repository or git history.",
  "memory: entries can be stale; verify names, paths and commands against the current project before relying on them.",
  "memory: one topic per file; update an existing entry instead of adding a duplicate.",
];

/** 结果的 details（落盘不进上下文）：只有命令、路径与错误码，不含正文。 */
export interface MemoryToolDetails {
  command: string;
  path?: string;
  code?: string;
}

function fail(input: Partial<MemoryInput>, code: string, message: string): ToolResult {
  const details: MemoryToolDetails = { command: String(input.command ?? ""), code };
  if (typeof input.path === "string") details.path = input.path;
  return { content: message, isError: true, details };
}

export function createMemoryTool(runtime: MemoryRuntime): ToolDefinition<MemoryInput> {
  return {
    name: MEMORY_TOOL,
    label: "Memory",
    description:
      "Notes that persist across sessions, stored as Markdown files under /memories/<scope>/ (scopes and entries are listed in the memory index). " +
      "Commands: view a directory or file, create (or overwrite) a file, str_replace a unique string, delete a file.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", enum: ["view", "create", "str_replace", "delete"] },
        path: { type: "string", description: "e.g. /memories/user/prefers-pnpm.md" },
        view_range: { type: "array", items: { type: "integer" } },
        file_text: { type: "string", description: "create: full Markdown content" },
        old_str: { type: "string" },
        new_str: { type: "string" },
      },
      required: ["command", "path"],
      additionalProperties: false,
    },
    permission: "memory",
    executionMode: "sequential",
    promptSnippet: "memory: read and save notes that persist across sessions",
    promptGuidelines: MEMORY_GUIDELINES,
    async execute(input, ctx): Promise<ToolResult> {
      const command = input?.command;
      const write = command !== "view";
      if (ctx.depth > 0) {
        if (runtime.subagents === "off")
          return fail(input, "subagent", "subagents cannot access memory");
        if (write) return fail(input, "subagent", "subagents cannot modify memory");
      }
      if (write && !runtime.writesEnabled)
        return fail(input, "disabled", "memory writes are turned off for this session");
      const store = runtime.store;
      try {
        switch (command) {
          case "view":
            return {
              content: store.view(input.path, input.view_range),
              details: { command, path: input.path } satisfies MemoryToolDetails,
            };
          case "create":
          case "str_replace":
          case "delete": {
            const result =
              command === "create"
                ? await store.create(input.path, input.file_text)
                : command === "str_replace"
                  ? await store.strReplace(input.path, input.old_str, input.new_str)
                  : await store.delete(input.path);
            const verb =
              command === "delete" ? "Deleted" : result.created ? "Saved new entry" : "Updated";
            return {
              content: `${verb} ${result.path}. The memory index will show it from the next session.`,
              details: { command, path: result.path } satisfies MemoryToolDetails,
            };
          }
          default:
            return fail(
              input,
              "invalid_command",
              'command must be "view", "create", "str_replace" or "delete"',
            );
        }
      } catch (error) {
        if (error instanceof MemoryError || error instanceof MemoryLockError)
          return fail(input, error.code, error.message);
        throw error;
      }
    },
  };
}
