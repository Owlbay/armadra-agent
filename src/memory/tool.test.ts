/**
 * `memory` 工具（docs/history/wave6-plan.md §3.3、D10）：命令分派、子会话与 /memory off 的执行层拒绝、错误给模型的英文说明。
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import type { ToolContext } from "../tools/types.js";
import { validateToolDefinition } from "../tools/registry.js";
import { MemoryRuntime } from "./runtime.js";
import { MemoryStore } from "./store.js";
import { MEMORY_GUIDELINES, createMemoryTool, type MemoryInput } from "./tool.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function setup(subagents: "off" | "read" = "read") {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ama-mem-tool-")));
  dirs.push(base);
  const store = new MemoryStore({ user: join(base, "user") }, undefined, {
    today: () => "2026-10-03",
  });
  const runtime = new MemoryRuntime(store, { subagents, embedded: false });
  const tool = createMemoryTool(runtime);
  const run = (input: Partial<MemoryInput>, depth = 0) =>
    tool.execute(input as MemoryInput, { ...makeToolContext(base), depth } as ToolContext);
  return { runtime, tool, run };
}

describe("memory 工具", () => {
  it("定义：权限类 memory、注册校验通过、描述与 guidelines 固定英文", () => {
    const { tool } = setup();
    expect(tool.permission).toBe("memory");
    expect(() => validateToolDefinition(tool)).not.toThrow();
    const text = [tool.description, tool.promptSnippet, ...MEMORY_GUIDELINES].join("\n");
    expect(text).not.toMatch(/[一-鿿]/);
    expect(tool.description.split(/(?<=\.)\s/)).toHaveLength(2);
    expect(MEMORY_GUIDELINES).toHaveLength(3);
  });

  it("create / view / str_replace / delete；写入提示下次会话进索引", async () => {
    const { run } = setup();
    const saved = await run({ command: "create", path: "/memories/user/a.md", file_text: "x" });
    expect(saved).toMatchObject({
      content:
        "Saved new entry /memories/user/a.md. The memory index will show it from the next session.",
      details: { command: "create", path: "/memories/user/a.md" },
    });
    expect(saved.isError).toBeUndefined();
    const view = await run({ command: "view", path: "/memories/user/a.md" });
    expect(String(view.content)).toContain("\tx");
    const updated = await run({
      command: "str_replace",
      path: "/memories/user/a.md",
      old_str: "\n\nx",
      new_str: "\n\ny",
    });
    expect(String(updated.content)).toMatch(/^Updated \/memories\/user\/a\.md\./);
    const deleted = await run({ command: "delete", path: "/memories/user/a.md" });
    expect(String(deleted.content)).toMatch(/^Deleted /);
  });

  it("错误：凭据、路径、未知命令都以 isError 返回（不抛），details 不含正文", async () => {
    const { run } = setup();
    const secret = await run({
      command: "create",
      path: "/memories/user/k.md",
      file_text: "ghp_abcdefghijklmnopqrstuvwxyz0123",
    });
    expect(secret).toEqual({
      content: "looks like a credential (GitHub token); not saved",
      isError: true,
      details: { command: "create", code: "credential", path: "/memories/user/k.md" },
    });
    const bad = await run({ command: "view", path: "/memories/user/../../x.md" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("'..'");
    const unknown = await run({ command: "rename" as never, path: "/memories/user/a.md" });
    expect(unknown).toMatchObject({ isError: true, details: { code: "invalid_command" } });
  });

  it("子会话 read：view 可以、写命令拒绝；off：view 也拒绝", async () => {
    const read = setup("read");
    await read.run({ command: "create", path: "/memories/user/a.md", file_text: "x" });
    expect(
      (await read.run({ command: "view", path: "/memories/user" }, 1)).isError,
    ).toBeUndefined();
    const write = await read.run(
      { command: "create", path: "/memories/user/b.md", file_text: "y" },
      1,
    );
    expect(write).toMatchObject({ content: "subagents cannot modify memory", isError: true });
    const off = setup("off");
    expect(await off.run({ command: "view", path: "/memories/user" }, 1)).toMatchObject({
      content: "subagents cannot access memory",
      isError: true,
    });
  });

  it("/memory off 后本会话写命令被拒，view 照常", async () => {
    const { runtime, run } = setup();
    runtime.writesEnabled = false;
    expect(
      await run({ command: "create", path: "/memories/user/a.md", file_text: "x" }),
    ).toMatchObject({ content: "memory writes are turned off for this session", isError: true });
    expect((await run({ command: "view", path: "/memories" })).isError).toBeUndefined();
  });
});
