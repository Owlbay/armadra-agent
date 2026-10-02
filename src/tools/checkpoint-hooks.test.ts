import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import type { CheckpointHooks } from "../checkpoints/types.js";
import { createEditTool } from "./edit.js";
import { createWriteTool } from "./write.js";

let tmp: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => tmp.cleanup());

/** 记录调用顺序；beforeWrite 时看一眼磁盘上的内容（必须还是旧的）。 */
function recorder(fail = false): { hooks: CheckpointHooks; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hooks: {
      beforeWrite: async (path) => {
        calls.push(`before:${existsSync(path) ? readFileSync(path, "utf8") : "<none>"}`);
        if (fail) throw new Error("disk full");
      },
      afterWrite: (path, content) => calls.push(`after:${readFileSync(path, "utf8") === content}`),
    },
  };
}

describe("edit / write 调用检查点钩子", () => {
  it("write：新建前 before（文件不存在），写后 after 拿到写入内容", async () => {
    const r = recorder();
    const ctx = makeToolContext(tmp.dir, { checkpoint: r.hooks });
    await createWriteTool().execute({ path: "n.txt", content: "hi" }, ctx);
    expect(r.calls).toEqual(["before:<none>", "after:true"]);
  });

  it("edit：写前 before 看到旧内容，after 内容与磁盘一致（含 CRLF）", async () => {
    const file = join(tmp.dir, "a.txt");
    writeFileSync(file, "one\r\ntwo\r\n");
    const r = recorder();
    const ctx = makeToolContext(tmp.dir, { checkpoint: r.hooks });
    ctx.markRead(file);
    const res = await createEditTool().execute(
      { path: "a.txt", edits: [{ oldText: "two", newText: "2" }] },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(r.calls).toEqual(["before:one\r\ntwo\r\n", "after:true"]);
  });

  it("钩子抛错不影响写入，只记 warn", async () => {
    const r = recorder(true);
    const ctx = makeToolContext(tmp.dir, { checkpoint: r.hooks });
    const res = await createWriteTool().execute({ path: "n.txt", content: "hi" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(readFileSync(join(tmp.dir, "n.txt"), "utf8")).toBe("hi");
    expect(ctx.logs.some((l) => l.startsWith("warn:") && l.includes("disk full"))).toBe(true);
  });

  it("失败的编辑不调用钩子", async () => {
    const file = join(tmp.dir, "a.txt");
    writeFileSync(file, "abc");
    const r = recorder();
    const ctx = makeToolContext(tmp.dir, { checkpoint: r.hooks });
    ctx.markRead(file);
    const res = await createEditTool().execute(
      { path: "a.txt", edits: [{ oldText: "zzz", newText: "y" }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(r.calls).toEqual([]);
  });
});
