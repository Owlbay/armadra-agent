import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../permissions/types.js";
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
