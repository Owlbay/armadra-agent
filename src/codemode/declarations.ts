/**
 * 工具声明：JSON Schema 子集（`ai/types.ts` 的 JsonSchema）→ TypeScript 声明字符串（设计 §5.5）。[B10]
 *
 * - 每个工具一段：JSDoc 描述 + `name(args: {...}): Promise<R>;`，属性按 schema 原序，必填无 `?`，
 *   属性的 description 作为行内 JSDoc；`items` → `T[]`，`enum` → 字面量联合，空 object → `Record`。
 * - 返回类型：`bash` 解析为 `BashResult`（脚本里不受 50 KB 截断的结构化值），其余内置工具为文本，
 *   宿主 / SDK 工具可能返回结构化值，声明为 `unknown`。
 * - `inlineBudget`（估算 token = 字符 / 4）：按名排序依次内联，放不下的工具只列名字，脚本用
 *   `describeTool(name)` 取完整声明。输出只依赖输入，字节稳定（设计 §9.1）。
 */

import type { JsonSchema } from "../ai/types.js";

export const DEFAULT_INLINE_BUDGET = 3000;

/** 脚本里 `tools.bash()` 的解析值（设计 §5.5）。 */
export const BASH_RESULT_DECLARATION =
  "interface BashResult { output: string; truncated: boolean; fullOutputPath?: string; exitCode: number; wallTimeMs: number }";

export interface DeclarableTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface DeclarationOptions {
  /** 内置工具（非 bash）返回文本；其它来源返回 unknown。缺省 true。 */
  textResult?: boolean;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(name: string): string {
  return IDENT_RE.test(name) ? name : JSON.stringify(name);
}

function jsdoc(text: string | undefined, indent: string): string {
  if (text === undefined || text.trim() === "") return "";
  const clean = text.replace(/\*\//g, "*\\/").trim();
  if (!clean.includes("\n")) return `${indent}/** ${clean} */\n`;
  const body = clean
    .split("\n")
    .map((line) => `${indent} * ${line}`.trimEnd())
    .join("\n");
  return `${indent}/**\n${body}\n${indent} */\n`;
}

/** 单个 schema → TypeScript 类型表达式。 */
export function schemaToType(schema: JsonSchema | undefined, indent = ""): string {
  if (schema === undefined) return "unknown";
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const item = schemaToType(schema.items, indent);
      return /[|&]/.test(item) && !item.startsWith("{") ? `(${item})[]` : `${item}[]`;
    }
    case "object":
      return objectType(schema, indent);
    default:
      return schema.properties !== undefined ? objectType(schema, indent) : "unknown";
  }
}

function objectType(schema: JsonSchema, indent: string): string {
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) return "Record<string, unknown>";
  const required = new Set(schema.required ?? []);
  const inner = `${indent}  `;
  const lines = properties.map(([name, prop]) => {
    const optional = required.has(name) ? "" : "?";
    return `${jsdoc(prop.description, inner)}${inner}${propertyKey(name)}${optional}: ${schemaToType(prop, inner)};`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/** 单个工具的声明（describeTool 返回它）。 */
export function toolDeclaration(tool: DeclarableTool, options: DeclarationOptions = {}): string {
  const returns =
    tool.name === "bash" ? "BashResult" : options.textResult === false ? "unknown" : "string";
  const args = schemaToType(tool.parameters);
  return `${jsdoc(tool.description, "")}${tool.name}(args: ${args}): Promise<${returns}>;`;
}

export interface DeclarationBlock {
  /** 内联进 codemode 描述的声明（按名排序）。 */
  inline: string[];
  /** 超出预算、只列名字的工具。 */
  namesOnly: string[];
  /** 拼好的文本。 */
  text: string;
}

/**
 * 按预算拼工具声明。工具按名排序；预算按估算 token 累计，第一个放不下的之后全部只列名字
 * （保持按名顺序、不跳着塞小的，便于模型理解「后面的去 describeTool 查」）。
 */
export function buildDeclarationBlock(
  tools: readonly { tool: DeclarableTool; textResult?: boolean }[],
  inlineBudget: number = DEFAULT_INLINE_BUDGET,
): DeclarationBlock {
  const sorted = [...tools].sort((a, b) => (a.tool.name < b.tool.name ? -1 : 1));
  const inline: string[] = [];
  const namesOnly: string[] = [];
  let used = 0;
  for (const { tool, textResult } of sorted) {
    const decl = toolDeclaration(tool, textResult === false ? { textResult } : {});
    const cost = estimateTokens(decl);
    if (namesOnly.length === 0 && used + cost <= inlineBudget) {
      inline.push(decl);
      used += cost;
    } else namesOnly.push(tool.name);
  }
  const parts: string[] = [];
  if (sorted.some(({ tool }) => tool.name === "bash")) parts.push(BASH_RESULT_DECLARATION);
  if (inline.length > 0) {
    parts.push(`declare const tools: {\n${indent(inline.join("\n"))}\n};`);
  }
  if (namesOnly.length > 0) {
    parts.push(
      `// Also callable (use describeTool(name) for the signature): ${namesOnly.join(", ")}`,
    );
  }
  return { inline, namesOnly, text: parts.join("\n") };
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}
