import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { createLsTool } from "./ls.js";
import { createTodoTool, readTodoState, TODO_CUSTOM_TYPE, validateTodoItems } from "./todo.js";

let tmp: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => tmp.cleanup());

describe("ls", () => {
  const tool = createLsTool();
  it.runIf(process.platform !== "win32")("目录 /、大小、符号链接、点文件、limit", async () => {
    mkdirSync(join(tmp.dir, "sub"));
    writeFileSync(join(tmp.dir, "b.txt"), "12345");
    writeFileSync(join(tmp.dir, ".hidden"), "");
    symlinkSync("b.txt", join(tmp.dir, "link"));
    symlinkSync("sub", join(tmp.dir, "dlink"));
    const ctx = makeToolContext(tmp.dir);
    const r = await tool.execute({}, ctx);
    expect(r.content).toBe(
      [".hidden  (0 B)", "b.txt  (5 B)", "dlink/ -> sub", "link -> b.txt", "sub/"].join("\n"),
    );
    const lim = await tool.execute({ limit: 2 }, ctx);
    expect(lim.content).toContain("[5 entries; showing the first 2.");
    expect((await tool.execute({ path: "b.txt" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ path: "nope" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ path: "sub" }, ctx)).content).toBe("(sub is empty)");
  });

  it("不含符号链接的基本列表（各平台）", async () => {
    mkdirSync(join(tmp.dir, "d"));
    writeFileSync(join(tmp.dir, "f.txt"), "abc");
    const r = await tool.execute({ path: "." }, makeToolContext(tmp.dir));
    expect(r.content).toBe("d/\nf.txt  (3 B)");
  });
});

describe("todo", () => {
  const tool = createTodoTool();
  it("set 写 custom 条目，get 读回", async () => {
    const ctx = makeToolContext(tmp.dir);
    const empty = await tool.execute({ action: "get" }, ctx);
    expect(empty.content).toBe("Tasks (0/0 done):\n(no tasks)");
    const items = [
      { id: "1", text: "plan", status: "done" as const },
      { id: "2", text: "build", status: "in_progress" as const },
      { id: "3", text: "ship", status: "pending" as const },
    ];
    const r = await tool.execute({ action: "set", items }, ctx);
    expect(r.content).toBe("Updated tasks (1/3 done):\n[x] 1. plan\n[~] 2. build\n[ ] 3. ship");
    expect(ctx.customs).toEqual([{ customType: TODO_CUSTOM_TYPE, data: { items } }]);
    const got = await tool.execute({ action: "get" }, ctx);
    expect(got.details).toEqual({ items });
    expect(readTodoState(ctx).items).toHaveLength(3);
    expect(tool.renderResult?.(got, 80, false)).toEqual([
      "[x] 1. plan",
      "[~] 2. build",
      "[ ] 3. ship",
    ]);
  });

  it("校验", async () => {
    const ctx = makeToolContext(tmp.dir);
    const bad = await tool.execute(
      { action: "set", items: [{ id: "1", text: "a", status: "nope" as never }] },
      ctx,
    );
    expect(bad.isError).toBe(true);
    expect(
      validateTodoItems([
        { id: "1", text: "a", status: "done" },
        { id: "1", text: "b", status: "done" },
      ]),
    ).toMatch(/duplicate/);
    expect(ctx.customs).toHaveLength(0);
  });
});
