/**
 * [W5-Z] 回滚（docs/history/rewind-plan.md、docs/reference/rpc.md「回滚」）bundle 级：
 * - RPC 同一进程两回合改文件，`rewind{mode:"code"}` 回到第二条消息之前——文件恢复成第一次写入的内容，对话不动；
 * - `-p` 两次（第二次 `-c`）改文件后用 RPC `-c` 回滚：ama 最后写入的内容只记在内存（tracker.lastWritten），
 *   换进程后当前内容不算「已知」，按冲突报告；`onConflict: "overwrite"` 覆盖恢复。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { hasBundle, runAma, spawnRpc, type Line, type RpcChild } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const ARGV = ["--model", "fake/echo", "--permission-mode", "auto-edit"];

const read = { steps: [{ toolCall: { name: "read", arguments: { path: "notes.txt" } } }] };
const write = (content: string) => ({
  steps: [{ toolCall: { name: "write", arguments: { path: "notes.txt", content } } }],
});

interface Point {
  entryId: string;
  text: string;
  hasCheckpoint: boolean;
}

async function call(rpc: RpcChild, id: string, command: object): Promise<Line> {
  const from = rpc.lines.length;
  rpc.send({ id, ...command });
  return rpc.waitFor((l) => l["id"] === id, from);
}

async function rewindPoints(rpc: RpcChild, id: string): Promise<Point[]> {
  const r = await call(rpc, id, { type: "get_rewind_points" });
  return (r["data"] as { points: Point[] }).points;
}

describe.skipIf(!hasBundle)("e2e：回滚（bundle 子进程）", () => {
  it("RPC 两回合改文件 → rewind code 恢复到第二回合之前，对话不动", async () => {
    home = createTmpHome();
    // 覆盖已有文件前须先读过（write 的约束），所以第二回合先 read 再 write。
    const script = home.write("script.json", {
      version: 1,
      responses: [write("v1\n"), { text: "wrote v1" }, read, write("v2\n"), { text: "wrote v2" }],
    });
    const file = join(home.cwd, "notes.txt");
    const rpc = spawnRpc(home, ARGV, { AMA_FAKE_SCRIPT: script });
    try {
      for (const [id, message] of [
        ["p1", "write v1"],
        ["p2", "write v2"],
      ] as const) {
        const from = rpc.lines.length;
        rpc.send({ id, type: "prompt", message });
        await rpc.waitFor((l) => l["type"] === "agent_settled", from);
      }
      expect(readFileSync(file, "utf8")).toBe("v2\n");
      const points = await rewindPoints(rpc, "pts");
      expect(points.map((p) => p.text)).toEqual(["write v1", "write v2"]);
      expect(points.every((p) => p.hasCheckpoint)).toBe(true);

      const rw = await call(rpc, "rw", {
        type: "rewind",
        entryId: points[1]!.entryId,
        mode: "code",
      });
      expect(rw).toMatchObject({
        success: true,
        data: { code: { restored: ["notes.txt"], conflicts: [] } },
      });
      expect(readFileSync(file, "utf8")).toBe("v1\n");
      expect(await rewindPoints(rpc, "pts2")).toHaveLength(2);
    } finally {
      expect(await rpc.close()).toBe(0);
    }
  });

  it("-p 两次改文件 → RPC -c 回滚：换进程后报冲突，overwrite 恢复", async () => {
    home = createTmpHome();
    const first = await runAma(home, ["-p", "write v1", ...ARGV], {
      env: {
        AMA_FAKE_SCRIPT: home.write("s1.json", {
          version: 1,
          responses: [write("v1\n"), { text: "wrote v1" }],
        }),
      },
    });
    expect(first.code).toBe(0);
    const second = await runAma(home, ["-p", "write v2", "-c", ...ARGV], {
      env: {
        AMA_FAKE_SCRIPT: home.write("s2.json", {
          version: 1,
          responses: [read, write("v2\n"), { text: "wrote v2" }],
        }),
      },
    });
    expect(second.code).toBe(0);
    const file = join(home.cwd, "notes.txt");
    expect(readFileSync(file, "utf8")).toBe("v2\n");

    const rpc = spawnRpc(home, ["-c", ...ARGV]);
    try {
      const points = await rewindPoints(rpc, "pts");
      expect(points.map((p) => p.text)).toEqual(["write v1", "write v2"]);
      const target = { type: "rewind", entryId: points[1]!.entryId, mode: "code" };
      const skip = await call(rpc, "skip", target);
      expect(skip).toMatchObject({
        success: true,
        data: { code: { conflicts: ["notes.txt"], restored: [] } },
      });
      expect(readFileSync(file, "utf8")).toBe("v2\n");
      const over = await call(rpc, "over", { ...target, onConflict: "overwrite" });
      expect(over).toMatchObject({ success: true, data: { code: { restored: ["notes.txt"] } } });
      expect(readFileSync(file, "utf8")).toBe("v1\n");
    } finally {
      expect(await rpc.close()).toBe(0);
    }
  });
});
