/**
 * JSON Schema 子集校验（设计 §2、§5.1）。[B0] 所有。
 *
 * 子集：type（object / string / number / integer / boolean / array）、properties、required、
 * additionalProperties（布尔）、items、enum（原始值）、description / title / default（只做注释）。
 *
 * - `validateSchema(schema, value)` 返回错误列表；空数组 = 通过。路径形如 `$.edits[0].oldText`，
 *   非标识符键用 `$["a b"]`。
 * - `checkSchemaSubset(schema)` 检查 schema 本身只用了子集关键字（工具注册时调用）。
 * - 不做类型强转（"1" 不会当作 1），不填 default。
 */

import type { JsonPrimitive, JsonSchema, JsonSchemaType } from "../ai/types.js";

export type { JsonSchema, JsonSchemaType } from "../ai/types.js";

export type SchemaErrorKeyword = "type" | "required" | "additionalProperties" | "enum";

export interface SchemaError {
  /** `$` 为根。 */
  path: string;
  keyword: SchemaErrorKeyword;
  message: string;
}

const SCHEMA_TYPES: readonly JsonSchemaType[] = [
  "object",
  "string",
  "number",
  "integer",
  "boolean",
  "array",
];

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "default",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return IDENTIFIER.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "non-finite number";
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function matchesType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
  }
}

function formatEnum(values: readonly JsonPrimitive[]): string {
  return values.map((v) => JSON.stringify(v)).join(", ");
}

function validateAt(schema: JsonSchema, value: unknown, path: string, out: SchemaError[]): void {
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    out.push({
      path,
      keyword: "type",
      message: `expected ${schema.type}, got ${describeValue(value)}`,
    });
    return;
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => candidate === value)) {
    out.push({
      path,
      keyword: "enum",
      message: `must be one of ${formatEnum(schema.enum)}`,
    });
  }

  if (isPlainObject(value) && (schema.type === "object" || schema.properties !== undefined)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        out.push({
          path: joinPath(path, key),
          keyword: "required",
          message: "is required",
        });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (childSchema !== undefined) {
        if (child !== undefined) validateAt(childSchema, child, joinPath(path, key), out);
      } else if (schema.additionalProperties === false) {
        out.push({
          path: joinPath(path, key),
          keyword: "additionalProperties",
          message: "is not allowed",
        });
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    value.forEach((item: unknown, index) => validateAt(items, item, joinPath(path, index), out));
  }
}

/** 校验 value；返回全部错误（不在第一处停下）。 */
export function validateSchema(schema: JsonSchema, value: unknown): SchemaError[] {
  const out: SchemaError[] = [];
  validateAt(schema, value, "$", out);
  return out;
}

/** 把错误列表格式化成给模型看的多行文本。 */
export function formatSchemaErrors(errors: readonly SchemaError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join("\n");
}

function checkSubsetAt(schema: unknown, path: string, out: string[]): void {
  if (!isPlainObject(schema)) {
    out.push(`${path}: schema must be an object`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) out.push(`${path}: unsupported keyword "${key}"`);
  }
  const { type, properties, required, additionalProperties, items, enum: enumValues } = schema;
  if (type !== undefined && !SCHEMA_TYPES.includes(type as JsonSchemaType)) {
    out.push(`${path}.type: unsupported type ${JSON.stringify(type)}`);
  }
  for (const key of ["title", "description"] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") {
      out.push(`${path}.${key}: must be a string`);
    }
  }
  if (properties !== undefined) {
    if (!isPlainObject(properties)) {
      out.push(`${path}.properties: must be an object`);
    } else {
      for (const [key, child] of Object.entries(properties)) {
        checkSubsetAt(child, joinPath(`${path}.properties`, key), out);
      }
    }
  }
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) {
      out.push(`${path}.required: must be an array of strings`);
    } else if (isPlainObject(properties)) {
      for (const name of required as string[]) {
        if (!Object.hasOwn(properties, name)) {
          out.push(`${path}.required: "${name}" is not declared in properties`);
        }
      }
    }
  }
  if (additionalProperties !== undefined && typeof additionalProperties !== "boolean") {
    out.push(`${path}.additionalProperties: only boolean is supported`);
  }
  if (items !== undefined) checkSubsetAt(items, `${path}.items`, out);
  if (enumValues !== undefined) {
    const ok =
      Array.isArray(enumValues) &&
      enumValues.length > 0 &&
      enumValues.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
    if (!ok) out.push(`${path}.enum: must be a non-empty array of primitives`);
  }
}

/** 检查 schema 只用了子集关键字；返回问题列表，空数组 = 合规。 */
export function checkSchemaSubset(schema: unknown): string[] {
  const out: string[] = [];
  checkSubsetAt(schema, "$", out);
  return out;
}
