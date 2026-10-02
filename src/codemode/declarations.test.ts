import { describe, expect, it } from "vitest";
import { builtinTools } from "../tools/registry.js";
import {
  BASH_RESULT_DECLARATION,
  DEFAULT_INLINE_BUDGET,
  buildDeclarationBlock,
  estimateTokens,
  schemaToType,
  toolDeclaration,
} from "./declarations.js";

const builtins = () => builtinTools().map((tool) => ({ tool }));

describe("schemaToType", () => {
  it("基本类型、数组、enum、嵌套对象、空对象", () => {
    expect(schemaToType({ type: "string" })).toBe("string");
    expect(schemaToType({ type: "integer" })).toBe("number");
    expect(schemaToType({ type: "array", items: { type: "boolean" } })).toBe("boolean[]");
    expect(schemaToType({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(schemaToType({ type: "array", items: { type: "string", enum: ["x", "y"] } })).toBe(
      '("x" | "y")[]',
    );
    expect(schemaToType({ type: "object" })).toBe("Record<string, unknown>");
    expect(schemaToType(undefined)).toBe("unknown");
    expect(
      schemaToType({
        type: "object",
        properties: {
          "odd-key": { type: "string", description: "with */ inside" },
          n: { type: "number" },
        },
        required: ["n"],
      }),
    ).toBe('{\n  /** with *\\/ inside */\n  "odd-key"?: string;\n  n: number;\n}');
  });

  it("工具声明：必填无 ?、bash 返回 BashResult、非内置返回 unknown", () => {
    const tool = {
      name: "canvas_send",
      description: "Send a message",
      parameters: { type: "object" as const, properties: { to: { type: "string" as const } } },
    };
    expect(toolDeclaration(tool)).toBe(
      "/** Send a message */\ncanvas_send(args: {\n  to?: string;\n}): Promise<string>;",
    );
    expect(toolDeclaration(tool, { textResult: false })).toMatch(/Promise<unknown>;$/);
    const bash = builtinTools().find((t) => t.name === "bash");
    expect(bash && toolDeclaration(bash)).toMatch(/Promise<BashResult>;$/);
  });
});

describe("buildDeclarationBlock", () => {
  it("内置工具的声明快照（缺省预算全部内联，按名排序）", () => {
    const block = buildDeclarationBlock(builtins());
    expect(block.namesOnly).toEqual([]);
    expect(block.inline.map((d) => /\n(\w+)\(args/.exec(d)?.[1])).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "ls",
      "read",
      "task",
      "task_ctl",
      "todo",
      "write",
    ]);
    expect(block.text.startsWith(BASH_RESULT_DECLARATION)).toBe(true);
    expect(estimateTokens(block.text)).toBeLessThan(DEFAULT_INLINE_BUDGET);
    expect(block.text).toMatchSnapshot();
  });

  it("预算超出：从第一个放不下的开始只列名字；同输入字节稳定", () => {
    const small = buildDeclarationBlock(builtins(), 300);
    expect(small.inline.length).toBeGreaterThan(0);
    expect(small.namesOnly.length).toBeGreaterThan(0);
    expect(small.text).toContain(
      `// Also callable (use describeTool(name) for the signature): ${small.namesOnly.join(", ")}`,
    );
    const none = buildDeclarationBlock(builtins(), 0);
    expect(none.inline).toEqual([]);
    expect(none.text).not.toContain("declare const tools");
    expect(none.text).toContain(BASH_RESULT_DECLARATION);
    expect(buildDeclarationBlock([...builtins()].reverse(), 300).text).toBe(small.text);
  });
});
