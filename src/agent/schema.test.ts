import { describe, expect, it } from "vitest";
import {
  checkSchemaSubset,
  formatSchemaErrors,
  joinPath,
  validateSchema,
  type JsonSchema,
} from "./schema.js";

const editSchema: JsonSchema = {
  type: "object",
  description: "edit tool",
  properties: {
    path: { type: "string", description: "file path" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: { oldText: { type: "string" }, newText: { type: "string" } },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    },
    replaceAll: { type: "boolean" },
  },
  required: ["path", "edits"],
};

describe("validateSchema: 基本类型", () => {
  it.each([
    ["string", "a", true],
    ["string", 1, false],
    ["number", 1.5, true],
    ["number", 3, true],
    ["number", "3", false],
    ["number", Number.NaN, false],
    ["number", Number.POSITIVE_INFINITY, false],
    ["integer", 3, true],
    ["integer", 3.5, false],
    ["integer", "3", false],
    ["boolean", false, true],
    ["boolean", 0, false],
    ["array", [], true],
    ["array", {}, false],
    ["object", {}, true],
    ["object", [], false],
    ["object", null, false],
  ] as const)("%s 接受 %j → %s", (type, value, ok) => {
    const errors = validateSchema({ type }, value);
    expect(errors.length === 0).toBe(ok);
    if (!ok) expect(errors[0]).toMatchObject({ path: "$", keyword: "type" });
  });

  it("无 type 时接受任意值", () => {
    expect(validateSchema({ description: "anything" }, { a: 1 })).toEqual([]);
    expect(validateSchema({}, null)).toEqual([]);
  });

  it("类型错误给出实际类型", () => {
    expect(validateSchema({ type: "string" }, null)[0]?.message).toBe("expected string, got null");
    expect(validateSchema({ type: "integer" }, 1.5)[0]?.message).toBe(
      "expected integer, got number",
    );
    expect(validateSchema({ type: "object" }, [1])[0]?.message).toBe("expected object, got array");
  });
});

describe("validateSchema: enum", () => {
  it("接受列出的值", () => {
    expect(validateSchema({ type: "string", enum: ["set", "get"] }, "get")).toEqual([]);
    expect(validateSchema({ enum: [1, null, true] }, null)).toEqual([]);
  });

  it("拒绝未列出的值并列出候选", () => {
    const errors = validateSchema({ type: "string", enum: ["set", "get"] }, "put");
    expect(errors).toEqual([
      { path: "$", keyword: "enum", message: 'must be one of "set", "get"' },
    ]);
  });

  it("enum 严格相等，不做转换", () => {
    expect(validateSchema({ enum: [1] }, "1")).toHaveLength(1);
  });
});

describe("validateSchema: object", () => {
  it("合法输入通过", () => {
    const value = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
    expect(validateSchema(editSchema, value)).toEqual([]);
  });

  it("缺必填字段给出字段路径", () => {
    const errors = validateSchema(editSchema, { edits: [] });
    expect(errors).toEqual([{ path: "$.path", keyword: "required", message: "is required" }]);
  });

  it("嵌套数组元素的错误带下标路径", () => {
    const errors = validateSchema(editSchema, {
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b" }, { oldText: 1 }],
    });
    expect(errors).toEqual([
      { path: "$.edits[1].newText", keyword: "required", message: "is required" },
      { path: "$.edits[1].oldText", keyword: "type", message: "expected string, got integer" },
    ]);
  });

  it("收集全部错误而不是第一处停下", () => {
    const errors = validateSchema(editSchema, { path: 1, edits: "x", replaceAll: "yes" });
    expect(errors.map((e) => e.path)).toEqual(["$.path", "$.edits", "$.replaceAll"]);
  });

  it("additionalProperties: false 拒绝多余字段", () => {
    const errors = validateSchema(editSchema, {
      path: "a",
      edits: [{ oldText: "a", newText: "b", extra: 1 }],
    });
    expect(errors).toEqual([
      { path: "$.edits[0].extra", keyword: "additionalProperties", message: "is not allowed" },
    ]);
  });

  it("缺省允许多余字段", () => {
    expect(validateSchema(editSchema, { path: "a", edits: [], other: true })).toEqual([]);
  });

  it("非标识符键用方括号路径", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { "a b": { type: "string" } },
      required: ["a b"],
    };
    expect(validateSchema(schema, {})[0]?.path).toBe('$["a b"]');
  });

  it("不把原型链上的键当作已声明属性", () => {
    const schema: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
    expect(validateSchema(schema, JSON.parse('{"toString": 1}'))).toHaveLength(1);
    expect(validateSchema({ type: "object", required: ["constructor"] }, {})).toHaveLength(1);
  });

  it("值为 undefined 的属性视为缺失", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    expect(validateSchema(schema, { a: undefined })).toEqual([
      { path: "$.a", keyword: "required", message: "is required" },
    ]);
  });
});

describe("validateSchema: array", () => {
  it("逐项校验", () => {
    const errors = validateSchema({ type: "array", items: { type: "integer" } }, [1, 2, "3", 4.5]);
    expect(errors.map((e) => e.path)).toEqual(["$[2]", "$[3]"]);
  });

  it("嵌套数组", () => {
    const schema: JsonSchema = {
      type: "array",
      items: { type: "array", items: { type: "string" } },
    };
    expect(validateSchema(schema, [["a"], ["b", 1]])[0]?.path).toBe("$[1][1]");
  });
});

describe("formatSchemaErrors / joinPath", () => {
  it("一行一处错误", () => {
    const text = formatSchemaErrors(validateSchema(editSchema, { edits: "x" }));
    expect(text).toBe("$.path: is required\n$.edits: expected array, got string");
  });

  it("joinPath", () => {
    expect(joinPath("$", "a")).toBe("$.a");
    expect(joinPath("$", 0)).toBe("$[0]");
    expect(joinPath("$", "1x")).toBe('$["1x"]');
  });
});

describe("checkSchemaSubset", () => {
  it("合规 schema 无问题", () => {
    expect(checkSchemaSubset(editSchema)).toEqual([]);
  });

  it("报出不支持的关键字与类型", () => {
    const problems = checkSchemaSubset({
      type: "object",
      properties: {
        n: { type: "number", minimum: 0 },
        u: { type: "null" },
        o: { oneOf: [] },
      },
      additionalProperties: { type: "string" },
    });
    expect(problems).toEqual([
      '$.properties.n: unsupported keyword "minimum"',
      '$.properties.u.type: unsupported type "null"',
      '$.properties.o: unsupported keyword "oneOf"',
      "$.additionalProperties: only boolean is supported",
    ]);
  });

  it("required 必须在 properties 里声明", () => {
    expect(
      checkSchemaSubset({ type: "object", properties: { a: {} }, required: ["a", "b"] }),
    ).toEqual(['$.required: "b" is not declared in properties']);
  });

  it("enum 必须是非空原始值数组", () => {
    expect(checkSchemaSubset({ enum: [] })).toEqual([
      "$.enum: must be a non-empty array of primitives",
    ]);
    expect(checkSchemaSubset({ enum: [{}] })).toHaveLength(1);
  });

  it("schema 本身不是对象", () => {
    expect(checkSchemaSubset("string")).toEqual(["$: schema must be an object"]);
    expect(checkSchemaSubset({ items: [] })).toEqual(["$.items: schema must be an object"]);
  });

  it("description 必须是字符串", () => {
    expect(checkSchemaSubset({ description: 1 })).toEqual(["$.description: must be a string"]);
  });
});
