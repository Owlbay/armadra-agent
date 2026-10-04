/**
 * ACP 线上形状的 schema 校验（docs/acp-plan.md §1.7、D14）。[ACP-C0]
 *
 * 官方 v1 schema（1.24.1，`test/fixtures/acp/schema-v1.24.1.json`，原样保存）+ 手写的最小 JSON Schema
 * 校验器：不加 devDependency。只实现这份 schema 用到的关键字——`$ref`（仅本文件 `#/$defs/…`）、
 * `type`（含数组形式）、`const`、`enum`、`properties`、`required`、`additionalProperties`、`items`、
 * `minimum`、`maximum`、`allOf`、`anyOf`、`oneOf`、`not`；`format`、`discriminator`、`default`、
 * `unevaluatedProperties`（只出现在一个 `other` 兜底分支）与 `x-*` 忽略，与仓库外用 ajv 跑的结论
 * 逐条比对过（PR 描述）。
 *
 * 方法 → `$defs` 的映射取自 schema 自带的 `x-method`：`<X>Request` 校验请求的 `params`，
 * `<X>Response` 校验答复的 `result`，`<X>Notification` 校验通知的 `params`；错误答复校验 `Error`。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Schema = boolean | { readonly [key: string]: unknown };

interface Root {
  $defs: Record<string, Schema>;
}

let cached: Root | undefined;

function root(): Root {
  cached ??= JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../fixtures/acp/schema-v1.24.1.json", import.meta.url)),
      "utf8",
    ),
  ) as Root;
  return cached;
}

/** schema 的 `$defs` 名单（测试用）。 */
export function acpDefs(): string[] {
  return Object.keys(root().$defs);
}

function resolveRef(ref: string): Schema {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref: ${ref}`);
  const target = root().$defs[ref.slice(prefix.length)];
  if (target === undefined) throw new Error(`unknown $ref: ${ref}`);
  return target;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeOk(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      throw new Error(`unsupported type: ${type}`);
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    );
  }
  return false;
}

function at(path: string): string {
  return path === "" ? "/" : path;
}

function errorsOf(schema: Schema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return errors;
}

function check(schema: Schema, value: unknown, path: string, errors: string[]): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${at(path)}: not allowed`);
    return;
  }
  const s = schema;
  if (typeof s["$ref"] === "string") check(resolveRef(s["$ref"]), value, path, errors);
  const type = s["type"];
  if (type !== undefined) {
    const types = Array.isArray(type) ? (type as string[]) : [type as string];
    if (!types.some((t) => typeOk(t, value))) {
      errors.push(`${at(path)}: expected ${types.join(" | ")}, got ${JSON.stringify(value)}`);
      return;
    }
  }
  if (Object.hasOwn(s, "const") && !equal(s["const"], value))
    errors.push(`${at(path)}: expected const ${JSON.stringify(s["const"])}`);
  const enumValues = s["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((e) => equal(e, value)))
    errors.push(`${at(path)}: expected one of ${JSON.stringify(enumValues)}`);
  if (typeof value === "number") {
    const min = s["minimum"];
    const max = s["maximum"];
    if (typeof min === "number" && value < min) errors.push(`${at(path)}: < minimum ${min}`);
    if (typeof max === "number" && value > max) errors.push(`${at(path)}: > maximum ${max}`);
  }
  if (isObject(value)) {
    const properties = (s["properties"] ?? {}) as Record<string, Schema>;
    const required = s["required"];
    if (Array.isArray(required))
      for (const key of required as string[])
        if (!Object.hasOwn(value, key)) errors.push(`${at(path)}: missing ${key}`);
    for (const [key, sub] of Object.entries(properties))
      if (Object.hasOwn(value, key)) check(sub, value[key], `${path}/${key}`, errors);
    const additional = s["additionalProperties"] as Schema | undefined;
    if (additional !== undefined)
      for (const key of Object.keys(value))
        if (!Object.hasOwn(properties, key))
          check(additional, value[key], `${path}/${key}`, errors);
  }
  const items = s["items"] as Schema | undefined;
  if (Array.isArray(value) && items !== undefined)
    value.forEach((item, i) => check(items, item, `${path}/${i}`, errors));
  const allOf = s["allOf"];
  if (Array.isArray(allOf)) for (const sub of allOf as Schema[]) check(sub, value, path, errors);
  const anyOf = s["anyOf"];
  if (Array.isArray(anyOf)) {
    const branches = (anyOf as Schema[]).map((sub) => errorsOf(sub, value, path));
    if (!branches.some((b) => b.length === 0))
      errors.push(`${at(path)}: matches no anyOf branch (closest: ${closest(branches)})`);
  }
  const oneOf = s["oneOf"];
  if (Array.isArray(oneOf)) {
    const branches = (oneOf as Schema[]).map((sub) => errorsOf(sub, value, path));
    const matched = branches.filter((b) => b.length === 0).length;
    if (matched === 0)
      errors.push(`${at(path)}: matches no oneOf branch (closest: ${closest(branches)})`);
    else if (matched > 1) errors.push(`${at(path)}: matches ${matched} oneOf branches`);
  }
  const not = s["not"] as Schema | undefined;
  if (not !== undefined && errorsOf(not, value, path).length === 0)
    errors.push(`${at(path)}: matches a "not" schema`);
}

/** 失败分支里错误最少的那个（报错时给人看）。 */
function closest(branches: string[][]): string {
  const best = [...branches].sort((a, b) => a.length - b.length)[0] ?? [];
  return best.slice(0, 3).join("; ");
}

/** 按 `$defs/<def>` 校验；返回错误列表，空即通过。 */
export function validateAcp(def: string, value: unknown): string[] {
  const schema = root().$defs[def];
  if (schema === undefined) return [`no $defs/${def}`];
  return errorsOf(schema, value, "");
}

// ---------------------------------------------------------------------------
// 线路
// ---------------------------------------------------------------------------

export interface AcpWireLine {
  /** 录制方向；答复按对方方向发出的请求 id 配对。 */
  dir: "in" | "out";
  msg: Record<string, unknown>;
}

interface MethodDefs {
  request?: string;
  response?: string;
  notification?: string;
}

let methods: Map<string, MethodDefs> | undefined;

/** `x-method` → 该方法的请求 / 答复 / 通知 `$defs`。 */
export function acpMethodDefs(): ReadonlyMap<string, MethodDefs> {
  if (methods !== undefined) return methods;
  methods = new Map();
  for (const [name, def] of Object.entries(root().$defs)) {
    if (typeof def !== "object") continue;
    const method = def["x-method"];
    if (typeof method !== "string") continue;
    const entry = methods.get(method) ?? {};
    if (name.endsWith("Request")) entry.request = name;
    else if (name.endsWith("Response")) entry.response = name;
    else if (name.endsWith("Notification")) entry.notification = name;
    methods.set(method, entry);
  }
  return methods;
}

/** 逐条校验一段线路；返回 `#<行号> <说明>: <错误>` 列表。 */
export function acpWireErrors(wire: readonly AcpWireLine[]): string[] {
  const errors: string[] = [];
  const pending = { in: new Map<unknown, string>(), out: new Map<unknown, string>() };
  const table = acpMethodDefs();
  wire.forEach(({ dir, msg }, index) => {
    const label = `#${index + 1} ${dir}`;
    const report = (what: string, list: string[]): void => {
      for (const e of list) errors.push(`${label} ${what}: ${e}`);
    };
    if (msg["jsonrpc"] !== "2.0") report("envelope", ['jsonrpc must be "2.0"']);
    const method = msg["method"];
    const id = msg["id"];
    if (typeof method === "string") {
      const defs = table.get(method);
      const isRequest = id !== undefined && id !== null;
      if (isRequest) pending[dir].set(id, method);
      if (method.startsWith("_")) return; // 扩展方法：规范不约束形状
      if (isRequest) {
        if (defs?.request !== undefined)
          report(`${method} request`, validateAcp(defs.request, msg["params"]));
        // 未知请求不校验 params；它的答复必须是错误（见下）
      } else if (defs?.notification !== undefined) {
        report(`${method} notification`, validateAcp(defs.notification, msg["params"]));
      } else {
        report(method, ["unknown notification"]);
      }
      return;
    }
    if (Object.hasOwn(msg, "raw")) {
      report("line", ["not JSON"]);
      return;
    }
    const other = dir === "in" ? "out" : "in";
    const requested = pending[other].get(id);
    if (requested === undefined) {
      report("response", [`no pending request with id ${JSON.stringify(id)}`]);
      return;
    }
    pending[other].delete(id);
    if (msg["error"] !== undefined) {
      report(`${requested} error`, validateAcp("Error", msg["error"]));
      return;
    }
    const response = table.get(requested)?.response;
    if (response !== undefined) report(`${requested} result`, validateAcp(response, msg["result"]));
    else if (!requested.startsWith("_"))
      report(`${requested} result`, ["result for a method the schema does not define"]);
  });
  return errors;
}

/** 有任何一条不合 schema 就抛错（错误列表进消息）。 */
export function assertAcpWire(wire: readonly AcpWireLine[]): void {
  const errors = acpWireErrors(wire);
  if (errors.length > 0) throw new Error(`ACP wire violates schema v1.24.1:\n${errors.join("\n")}`);
}

/** 读一份 `{dir,msg}` 的 JSONL 录制。 */
export function readAcpWire(file: string): AcpWireLine[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AcpWireLine);
}
