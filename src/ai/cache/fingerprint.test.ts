import { describe, expect, it } from "vitest";
import type { Message, SystemMessage, ToolDecl, TranscriptContext } from "../types.js";
import { changedSections, fingerprintChange, fingerprintContext, hash16 } from "./fingerprint.js";

const model = { provider: "anthropic", id: "claude-sonnet-5-5" };

function tool(name: string, description = `${name} tool`): ToolDecl {
  return { name, description, parameters: { type: "object", properties: {} } };
}

function system(
  tools: ToolDecl[],
  sections: Record<string, string> = { a: "rules" },
): SystemMessage {
  return { role: "system", sections, toolsAdded: tools, timestamp: 1 };
}

function context(...messages: Message[]): TranscriptContext {
  return { messages };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 2 });

describe("fingerprintContext（§1.2）", () => {
  it("16 位 hex；同一上下文稳定，对话增长不改指纹", () => {
    const base = system([tool("read"), tool("bash")]);
    const a = fingerprintContext(context(base, user("hi")), model);
    const b = fingerprintContext(context(base, user("hi"), user("more")), model);
    expect(a.system).toMatch(/^[0-9a-f]{16}$/);
    expect(a.tools).toMatch(/^[0-9a-f]{16}$/);
    expect(a.model).toBe("anthropic/claude-sonnet-5-5");
    expect(b).toEqual(a);
    expect(hash16("x")).toBe(hash16("x"));
  });

  it("工具按名排序：声明顺序不同指纹相同；改一个工具描述只变 tools", () => {
    const a = fingerprintContext(context(system([tool("read"), tool("bash")])), model);
    const b = fingerprintContext(context(system([tool("bash"), tool("read")])), model);
    expect(b).toEqual(a);
    const c = fingerprintContext(context(system([tool("read", "changed"), tool("bash")])), model);
    expect(c.system).toBe(a.system);
    expect(c.tools).not.toBe(a.tools);
    expect(fingerprintChange(a, c)).toBe("tools");
  });

  it("中途节补丁作为尾部上下文送达 → system 指纹不变；开头的节变了 → system；换模型 → model", () => {
    const base = system([tool("read")]);
    const a = fingerprintContext(context(base, user("q")), model);
    const patch: SystemMessage = { role: "system", sections: { a: "new rules" }, timestamp: 3 };
    const b = fingerprintContext(context(base, user("q"), patch), model);
    expect(b).toEqual(a);
    const rewritten = fingerprintContext(
      context(system([tool("read")], { a: "new rules" }), user("q")),
      model,
    );
    expect(rewritten.tools).toBe(a.tools);
    expect(fingerprintChange(a, rewritten)).toBe("system");
    const c = fingerprintContext(context(base, user("q")), { provider: "x", id: "y" });
    expect(fingerprintChange(a, c)).toBe("model");
    expect(fingerprintChange(a, a)).toBeUndefined();
  });

  it("[ME-B] 按节指纹：每个非空节一个 hash16；changedSections 按节顺序列改动 / 新增，再列消失的", () => {
    const a = fingerprintContext(context(system([], { a: "rules", b: "x", c: "y" })), model);
    expect(Object.keys(a.sections ?? {})).toEqual(["a", "b", "c"]);
    expect(a.sections?.["a"]).toBe(hash16("rules"));
    const b = fingerprintContext(context(system([], { a: "rules", b: "x2", d: "z" })), model);
    expect(changedSections(a, b)).toEqual(["b", "d", "c"]);
    expect(changedSections(a, a)).toEqual([]);
    const { sections: _s, ...legacy } = a;
    expect(changedSections(legacy, b)).toEqual([]);
  });
});
