/**
 * ToolRegistry：内置 + 宿主 / SDK 注册、disable、活动集、按名排序（设计 §1.2、§5.1）。[B3]
 *
 * - 注册校验：名字 `^[a-z][a-z0-9_]{1,63}$`、`parameters` 只用 JSON Schema 子集（checkSchemaSubset）、
 *   同名 → AmaError{code:"tool_exists"}；
 * - `disable(name)` 后不再出现在 `list()` / `active()`，也不能被 `setActive` 选中；未注册的名字也
 *   记下（宿主可能先 disable 再由内置注册，例如 `disable("task")`）；
 * - 活动集缺省 = 全部已注册且未禁用；`setActive(names)` 之后只用这些（未知名 → tool_not_found）；
 * - `builtinTools()` 给出全部内置工具（skill 工具需要技能列表来源）。
 */

import { AmaError } from "../errors.js";
import { checkSchemaSubset } from "../agent/schema.js";
import type { ToolDefinition, ToolExecutionMode, ToolRegistryApi, ToolSource } from "./types.js";
import { createReadTool, type ReadToolOptions } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createBashTool, type BashToolOptions } from "./bash.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createLsTool } from "./ls.js";
import { createTodoTool } from "./todo.js";
import { createSkillTool } from "./skill.js";
import { createTaskTool, type TaskToolOptions } from "./task.js";
import type { Skill } from "../skills/discover.js";

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/** 未声明时：read → parallel；write / execute → sequential。 */
export function executionModeOf(
  tool: Pick<ToolDefinition, "permission" | "executionMode">,
): ToolExecutionMode {
  return tool.executionMode ?? (tool.permission === "read" ? "parallel" : "sequential");
}

export function validateToolDefinition(tool: ToolDefinition): void {
  if (typeof tool.name !== "string" || !TOOL_NAME_RE.test(tool.name)) {
    throw new AmaError("invalid_arguments", `Invalid tool name "${String(tool.name)}"`);
  }
  if (!["read", "write", "execute"].includes(tool.permission)) {
    throw new AmaError("invalid_arguments", `Tool ${tool.name}: invalid permission`);
  }
  if (typeof tool.execute !== "function") {
    throw new AmaError("invalid_arguments", `Tool ${tool.name}: execute must be a function`);
  }
  const problems = checkSchemaSubset(tool.parameters);
  if (problems.length > 0) {
    throw new AmaError(
      "invalid_arguments",
      `Tool ${tool.name}: parameters use unsupported schema features: ${problems.join("; ")}`,
    );
  }
}

interface Entry {
  tool: ToolDefinition;
  source: ToolSource;
}

export class ToolRegistry implements ToolRegistryApi {
  private readonly entries = new Map<string, Entry>();
  private readonly disabled = new Set<string>();
  private activeNames: Set<string> | undefined;

  register(tool: ToolDefinition, source: ToolSource): void {
    validateToolDefinition(tool);
    if (this.entries.has(tool.name)) {
      throw new AmaError("tool_exists", `Tool "${tool.name}" is already registered`);
    }
    this.entries.set(tool.name, { tool, source });
  }

  disable(name: string): void {
    this.disabled.add(name);
    this.activeNames?.delete(name);
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.disabled.has(name) ? undefined : this.entries.get(name)?.tool;
  }

  sourceOf(name: string): ToolSource | undefined {
    return this.entries.get(name)?.source;
  }

  list(): readonly string[] {
    return [...this.entries.keys()].filter((n) => !this.disabled.has(n)).sort();
  }

  active(): readonly ToolDefinition[] {
    const names = this.list().filter(
      (n) => this.activeNames === undefined || this.activeNames.has(n),
    );
    return names.map((n) => (this.entries.get(n) as Entry).tool);
  }

  setActive(names: readonly string[]): void {
    for (const name of names) {
      if (!this.entries.has(name) || this.disabled.has(name)) {
        throw new AmaError("tool_not_found", `Unknown or disabled tool "${name}"`);
      }
    }
    this.activeNames = new Set(names);
  }
}

export interface BuiltinToolOptions {
  /** skill 工具的技能来源；缺省时不注册 skill。 */
  getSkills?(): readonly Skill[];
  read?: ReadToolOptions;
  bash?: BashToolOptions;
  task?: TaskToolOptions;
}

/** 全部内置工具（read / write / edit / bash / grep / glob / ls / todo / skill / task）。 */
export function builtinTools(options: BuiltinToolOptions = {}): ToolDefinition[] {
  const tools = [
    createReadTool(options.read),
    createWriteTool(),
    createEditTool(),
    createBashTool(options.bash),
    createGrepTool(),
    createGlobTool(),
    createLsTool(),
    createTodoTool(),
    createTaskTool(options.task),
  ] as ToolDefinition[];
  if (options.getSkills)
    tools.push(createSkillTool({ getSkills: options.getSkills }) as ToolDefinition);
  return tools;
}

/** 新建注册表并登记全部内置工具；`disabled` 来自 config.tools.disabled。 */
export function createToolRegistry(
  options: BuiltinToolOptions & { disabled?: readonly string[] } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of builtinTools(options)) registry.register(tool, "builtin");
  for (const name of options.disabled ?? []) registry.disable(name);
  return registry;
}
