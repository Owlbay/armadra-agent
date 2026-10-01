import { describe, expect, it } from "vitest";
import { parseJsonLenient, parsePartialJson, parseToolArguments } from "./json-partial.js";

describe("parsePartialJson", () => {
  it("完整 JSON 与 JSON.parse 一致", () => {
    const value = { a: [1, 2.5, -3e2, true, false, null], b: { c: 'x"y\\z\né' } };
    expect(parsePartialJson(JSON.stringify(value))).toEqual(value);
  });

  it.each([
    ["", undefined],
    ["{", {}],
    ['{"pa', {}],
    ['{"path"', {}],
    ['{"path":', {}],
    ['{"path": "src/ma', { path: "src/ma" }],
    ['{"path": "a", "limit": 2', { path: "a", limit: 2 }],
    ['{"n": -', {}],
    ['{"n": 1.', { n: 1 }],
    ['{"n": 1e', { n: 1 }],
    ['{"ok": tr', { ok: true }],
    ['{"v": nu', { v: null }],
    ['{"a": [1, 2, {"b": "c', { a: [1, 2, { b: "c" }] }],
    ['{"s": "line\\', { s: "line" }],
    ['{"s": "\\u00', { s: "" }],
    ["[1, 2", [1, 2]],
  ])("截断 %j → %j", (input, expected) => {
    expect(parsePartialJson(input)).toEqual(expected);
  });

  it("字符串里的裸控制字符与非法转义照收", () => {
    expect(parsePartialJson('{"code": "a\tb\nc", "re": "\\d+"}')).toEqual({
      code: "a\tb\nc",
      re: "\\d+",
    });
  });

  it("语法错误时返回错误点之前已解析的部分", () => {
    expect(parsePartialJson('{"a": 1, "b": @}')).toEqual({ a: 1 });
    expect(parsePartialJson("hello")).toBeUndefined();
  });
});

describe("parseToolArguments / parseJsonLenient", () => {
  it("总是返回对象", () => {
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("  ")).toEqual({});
    expect(parseToolArguments("[1,2]")).toEqual({});
    expect(parseToolArguments('"str"')).toEqual({});
    expect(parseToolArguments("garbage")).toEqual({});
    expect(parseToolArguments('{"x": 1}')).toEqual({ x: 1 });
    expect(parseToolArguments('{"x": {"y": [1')).toEqual({ x: { y: [1] } });
  });

  it("严格优先", () => {
    expect(parseJsonLenient("[1]")).toEqual([1]);
    expect(parseJsonLenient('{"a":"\t"}')).toEqual({ a: "\t" });
  });
});
