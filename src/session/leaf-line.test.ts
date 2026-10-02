import { appendFileSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { SessionManager } from "./manager.js";
import { migrateSessionLines } from "./migrate.js";
import type { SessionLine } from "./types.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function dir(): string {
  home = createTmpHome("ama-c1b-leaf-");
  return home.path("sessions");
}

function lines(file: string): SessionLine[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SessionLine);
}

function seed(manager: SessionManager): string[] {
  return ["a", "b", "c"].map(
    (text) =>
      manager.append({ type: "message", message: { role: "user", content: text, timestamp: 0 } })
        .id,
  );
}

describe("leaf 行（第三波 A7：/tree 位置落盘）", () => {
  it("已落盘：setLeaf 追加 leaf 行；重开后叶子还原；条目 / 树不含 leaf 行", () => {
    const manager = SessionManager.create(dir(), "/work");
    const [a, b] = seed(manager);
    const file = manager.flush() as string;
    manager.setLeaf(a!);
    expect(lines(file).at(-1)).toMatchObject({ type: "leaf", id: a });
    manager.close();
    const reopened = SessionManager.open(file);
    expect(reopened.leafId()).toBe(a);
    expect(reopened.branch().map((e) => e.id)).toEqual([a]);
    expect(reopened.entries()).toHaveLength(3);
    expect(reopened.entries().some((e) => (e.type as string) === "leaf")).toBe(false);
    expect(reopened.getEntries().entries).toHaveLength(3);
    expect(reopened.getTree()).toHaveLength(1);
    // leaf 行之后又追加条目 → 叶子是新条目
    const d = reopened.append({
      type: "message",
      message: { role: "user", content: "d", timestamp: 0 },
    });
    expect(d.parentId).toBe(a);
    reopened.close();
    const again = SessionManager.open(file);
    expect(again.leafId()).toBe(d.id);
    expect(again.branch().map((e) => e.id)).toEqual([a, d.id]);
    again.setLeaf(b!);
    again.setLeaf(null);
    again.close();
    expect(SessionManager.open(file).leafId()).toBeNull();
  });

  it("延迟会话：flush 时补写 leaf 行；叶子在最后一条条目时不写", () => {
    const lazy = SessionManager.create(dir(), "/work");
    const [a] = seed(lazy);
    lazy.setLeaf(a!);
    const file = lazy.flush() as string;
    expect(lines(file).filter((l) => l.type === "leaf")).toEqual([
      expect.objectContaining({ id: a }),
    ]);
    lazy.close();
    expect(SessionManager.open(file).leafId()).toBe(a);

    const plain = SessionManager.create(dir(), "/work");
    seed(plain);
    const plainFile = plain.flush() as string;
    expect(lines(plainFile).some((l) => l.type === "leaf")).toBe(false);
    plain.close();
  });

  it("fork 不复制 leaf 行；内存会话 setLeaf 不落盘", () => {
    const manager = SessionManager.create(dir(), "/work");
    const [a, b] = seed(manager);
    manager.flush();
    manager.setLeaf(a!);
    const forked = manager.fork(b!);
    const forkFile = forked.file() as string;
    expect(lines(forkFile).some((l) => l.type === "leaf")).toBe(false);
    expect(forked.leafId()).toBe(b);
    forked.close();
    manager.close();

    const memory = SessionManager.inMemory("/work");
    const [m] = seed(memory);
    memory.setLeaf(m!);
    expect(memory.leafId()).toBe(m);
  });

  it("migrate：指向不存在条目的 leaf 回落到最后一条；id 非字符串 / null 判损坏", () => {
    const manager = SessionManager.create(dir(), "/work");
    const ids = seed(manager);
    const file = manager.flush() as string;
    manager.close();
    appendFileSync(file, `${JSON.stringify({ type: "leaf", id: "nope", timestamp: "t" })}\n`);
    expect(SessionManager.open(file).leafId()).toBe(ids.at(-1));
    const header = lines(file)[0]!;
    expect(() => migrateSessionLines([header, { type: "leaf", id: 3 } as never], "f")).toThrow(
      /malformed leaf line/,
    );
    expect(migrateSessionLines([header, { type: "leaf", id: null } as never]).leafId).toBeNull();
  });
});
