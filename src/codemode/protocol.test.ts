import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRIPT_OPTIONS,
  LineSplitter,
  decodeChildLine,
  decodeParentLine,
  encodeLine,
  parseOptionsLine,
  type ChildMessage,
  type ParentMessage,
} from "./protocol.js";

describe("parseOptionsLine", () => {
  it("没有选项行 → 缺省值", () => {
    expect(parseOptionsLine("return 1")).toEqual(DEFAULT_SCRIPT_OPTIONS);
    expect(parseOptionsLine("")).toEqual(DEFAULT_SCRIPT_OPTIONS);
    // 选项行只认首行
    expect(parseOptionsLine('text(1)\n// @options: {"timeout_ms": 5}')).toEqual(
      DEFAULT_SCRIPT_OPTIONS,
    );
  });

  it("首行选项覆盖缺省值", () => {
    expect(
      parseOptionsLine('// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}\nreturn 1'),
    ).toEqual({ maxOutputTokens: 2000, timeoutMs: 60000 });
    expect(parseOptionsLine('  //@options:{"timeout_ms":5}')).toMatchObject({ timeoutMs: 5 });
  });

  it("非法 JSON、未知键、越界值报错", () => {
    expect(() => parseOptionsLine("// @options: {timeout_ms: 1}")).toThrow(/Invalid \/\/ @options/);
    expect(() => parseOptionsLine("// @options: [1]")).toThrow(/JSON object/);
    expect(() => parseOptionsLine('// @options: {"retries": 1}')).toThrow(/unknown option/);
    expect(() => parseOptionsLine('// @options: {"timeout_ms": 0}')).toThrow(/between 1/);
    expect(() => parseOptionsLine('// @options: {"timeout_ms": 1.5}')).toThrow(/integer/);
    expect(() => parseOptionsLine('// @options: {"max_output_tokens": "9"}')).toThrow(/integer/);
  });
});

describe("行协议编解码", () => {
  it("父 → 子、子 → 父往返", () => {
    const parent: ParentMessage[] = [
      {
        type: "run",
        script: "return 1",
        options: { ...DEFAULT_SCRIPT_OPTIONS },
        tools: [{ name: "read", declaration: "read(args: { path: string }): Promise<string>" }],
        store: { cursor: 3 },
      },
      { type: "tool_result", id: 1, ok: true, value: { a: [1, 2] } },
      { type: "tool_result", id: 2, ok: false, error: "denied" },
      { type: "abort" },
    ];
    for (const message of parent) {
      const line = encodeLine(message);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      expect(decodeParentLine(line)).toEqual(message);
    }
    const child: ChildMessage[] = [
      { type: "tool_call", id: 1, name: "read", input: { path: "a" } },
      { type: "output", text: "line\nnext" },
      { type: "store", entries: { k: 1, gone: null } },
      { type: "done", ok: false, error: "boom", elapsedMs: 12 },
    ];
    for (const message of child) expect(decodeChildLine(encodeLine(message))).toEqual(message);
  });

  it("U+2028 / U+2029 被转义，按 \\n 切行安全", () => {
    const line = encodeLine({ type: "output", text: "a\u2028b\u2029c" });
    expect(line).not.toMatch(/[\u2028\u2029]/);
    expect(decodeChildLine(line)).toEqual({ type: "output", text: "a\u2028b\u2029c" });
  });

  it("非法行报错；方向不对的消息被拒", () => {
    expect(() => decodeChildLine("{oops")).toThrow(/codemode protocol/);
    expect(() => decodeChildLine('{"type":"run"}')).toThrow(/unknown message/);
    expect(() => decodeParentLine('{"type":"done"}')).toThrow(/unknown message/);
    expect(() => decodeParentLine("42")).toThrow(/unknown message/);
  });

  it("LineSplitter：跨 chunk 拼行、跳过空行、flush 交出末行", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":')).toEqual([]);
    expect(splitter.push('1}\n\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.push(":3}")).toEqual([]);
    expect(splitter.flush()).toEqual(['{"c":3}']);
    expect(splitter.flush()).toEqual([]);
  });
});
