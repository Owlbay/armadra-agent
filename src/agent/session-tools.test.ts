import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeContext } from "../ai/context.js";
import type { ApprovalRequest } from "../permissions/types.js";
import { createReadTool } from "../tools/read.js";
import { createHarness } from "./testing/harness.js";
import { stubPermission, stubTool } from "./testing/stubs.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "ama-gate-"));
  writeFileSync(join(cwd, "a.txt"), "one\n");
  writeFileSync(join(cwd, "b.txt"), "two\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("gateToolCall：审批请求带 readFiles 与执行前预览", () => {
  it("write 覆盖已读文件 info、未读文件 warn；事件带同一份 preview；无可预览内容时缺省", async () => {
    const asked: ApprovalRequest[] = [];
    const read = stubTool({
      name: "read",
      properties: { path: { type: "string" } },
      run: (input, ctx) => {
        ctx.markRead(join(ctx.cwd, String(input["path"])));
        return { content: "one" };
      },
    });
    const write = stubTool({
      name: "write",
      permission: "write",
      properties: { path: { type: "string" }, content: { type: "string" } },
    });
    const host = stubTool({ name: "canvas_ping", permission: "write" });
    const h = createHarness({
      cwd,
      tools: [read, write, host],
      permission: stubPermission((input) =>
        input.permission === "write"
          ? { decision: "ask", step: "mode", approvalReason: "mode" }
          : undefined,
      ),
      brokers: [
        {
          ask: async (request) => {
            asked.push(request);
            return "deny";
          },
        },
      ],
      script: [
        { toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
        {
          toolCalls: [
            { name: "write", args: { path: "a.txt", content: "1\n2\n" } },
            { name: "write", args: { path: "b.txt", content: "x\n" } },
            { name: "canvas_ping", args: {} },
          ],
        },
        { text: "done" },
      ],
    });
    await h.session.prompt("go");
    expect(asked).toHaveLength(3);
    const [first, second, third] = asked as [ApprovalRequest, ApprovalRequest, ApprovalRequest];
    expect(first.context?.depth).toBe(0);
    expect([...(first.context?.readFiles ?? [])]).toEqual([join(cwd, "a.txt")]);
    expect(first.preview).toEqual({
      kind: "write",
      lines: ["覆盖 a.txt：1 行，4 B → 2 行，4 B"],
      severity: "info",
      affected: [{ path: "a.txt", exists: true, bytes: 4 }],
    });
    expect(second.preview?.severity).toBe("warn");
    expect(second.preview?.lines[1]).toContain("本会话未 read 过此文件");
    expect(third.preview).toBeUndefined();
    const events = h.events.filter((e) => e.type === "permission_request");
    expect(events.map((e) => ("preview" in e ? e.preview : undefined))).toEqual([
      first.preview,
      second.preview,
      undefined,
    ]);
    expect("preview" in (events[2] ?? {})).toBe(false);
  });
});

describe("[S-A] ToolContext.activeTools：会话活动集的只读快照", () => {
  it("read 收到目录时按活动集给提示；setActiveTools 之后的调用看到新集合", async () => {
    mkdirSync(join(cwd, "src"));
    const seen: string[][] = [];
    const probe = stubTool({
      name: "probe",
      run: (_input, ctx) => {
        seen.push([...(ctx.activeTools ?? [])].sort());
        return { content: "ok" };
      },
    });
    const glob = stubTool({ name: "glob" });
    const ls = stubTool({ name: "ls" });
    const h = createHarness({
      cwd,
      tools: [createReadTool(), probe, glob, ls],
      activeTools: ["read", "probe", "glob"],
      script: [
        {
          toolCalls: [
            { name: "read", args: { path: "src" } },
            { name: "probe", args: {} },
          ],
        },
        { text: "done" },
        { toolCalls: [{ name: "read", args: { path: "src" } }] },
        { text: "done" },
      ],
    });
    await h.session.prompt("go");
    h.session.setActiveTools(["read", "probe", "ls"]);
    await h.session.prompt("again");
    expect(seen).toEqual([["glob", "probe", "read"]]);
    const results = h.events.flatMap((e) =>
      e.type === "tool_execution_end" && e.toolName === "read" ? [e.result.content] : [],
    );
    expect(results).toEqual([
      'src is a directory; use glob (e.g. pattern "src/*")',
      "src is a directory; use the ls tool instead",
    ]);
  });
});

describe("[ME-C0] unavailableTools：留在工具表、执行时拒绝", () => {
  it("调用被拒且文案固定；请求工具表仍含该工具；其余工具照常执行", async () => {
    let ran = 0;
    const write = stubTool({
      name: "write",
      run: () => {
        ran++;
        return { content: "written" };
      },
    });
    const probe = stubTool({ name: "probe" });
    const h = createHarness({
      cwd,
      tools: [write, probe],
      unavailableTools: ["write"],
      script: [
        {
          toolCalls: [
            { name: "write", args: {} },
            { name: "probe", args: {} },
          ],
        },
        { text: "done" },
      ],
    });
    await h.session.prompt("go");
    expect(ran).toBe(0);
    const results = h.events.flatMap((e) =>
      e.type === "tool_execution_end" ? [[e.toolName, e.result.content, e.isError]] : [],
    );
    expect(results).toEqual([
      ["write", 'Tool "write" is not available in this session.', true],
      ["probe", "probe ok", false],
    ]);
    const tools = h.scripted.calls.map((call) =>
      normalizeContext(call.context).tools.map((t) => t.name),
    );
    expect(tools).toEqual([
      ["probe", "write"],
      ["probe", "write"],
    ]);
  });
});
