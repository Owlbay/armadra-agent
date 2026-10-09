/**
 * [ME-B] D5：对话开始后 tools / rules 节冻结为已发送的文本，工具增删只经请求工具表与尾部提醒体现；
 * 对话开始前照常重写。
 */

import { describe, expect, it } from "vitest";
import { createHarness } from "./testing/harness.js";
import { fakeModel, stubTool } from "./testing/stubs.js";

const tools = ["read", "bash"].map((name) => stubTool({ name, run: () => ({ content: name }) }));

function systemsOf(h: ReturnType<typeof createHarness>) {
  return h.manager
    .branch()
    .flatMap((e) => (e.type === "message" && e.message.role === "system" ? [e.message] : []));
}

describe("keepSectionsAfterStart", () => {
  it("对话开始后移除工具：补丁只有 toolsRemoved，tools / rules 节不改写；加回只有 toolsAdded", async () => {
    const h = createHarness({ model: fakeModel(), tools, script: [{ text: "a" }] });
    await h.session.prompt("q0");
    h.session.setActiveTools(["read"]);
    await h.session.prompt("q1");
    h.session.setActiveTools(["read", "bash"]);
    await h.session.prompt("q2");
    const [full, removed, restored] = systemsOf(h);
    expect(full?.sections["tools"]).toContain("bash");
    expect(removed).toMatchObject({ sections: {}, toolsRemoved: ["bash"] });
    expect(restored?.sections).toEqual({});
    expect(restored?.toolsAdded?.map((t) => t.name)).toEqual(["bash"]);
  });

  it("对话开始前改活动集：首条全量直接按新工具集写", async () => {
    const h = createHarness({ model: fakeModel(), tools, script: [{ text: "a" }] });
    h.session.setActiveTools(["read"]);
    await h.session.prompt("q0");
    const [full, ...rest] = systemsOf(h);
    expect(rest).toEqual([]);
    expect(full?.toolsAdded?.map((t) => t.name)).toEqual(["read"]);
    expect(full?.sections["tools"]).not.toContain("bash");
  });
});
