/**
 * 内存回归工具自检（docs/memory-plan.md D13）：GC 可用、WeakRef 可判回收、空操作噪声 < 1 MB、
 * 生成文件的形状。各批的回归用例放在本目录。[M-C0]
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readSessionLines } from "../../src/session/store.js";
import {
  forceGc,
  gcExposed,
  gcUntil,
  makeSessionFile,
  makeTextFile,
  measureGrowth,
  trackInstances,
} from "../helpers/memory.js";

const MB = 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), "ama-mem-helpers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("GC 与回收判定", () => {
  it("vitest worker 带 --expose-gc", () => {
    expect(gcExposed()).toBe(true);
    expect(() => forceGc()).not.toThrow();
  });

  it("WeakRef：释放引用后 gcUntil 判定可回收；仍被引用时不误报", async () => {
    let held: object | undefined = { payload: new Array(1000).fill(1) };
    const released = new WeakRef({ payload: new Array(1000).fill(2) });
    const kept = new WeakRef(held);
    expect(await gcUntil(() => released.deref() === undefined)).toBe(true);
    expect(await gcUntil(() => kept.deref() === undefined, 3)).toBe(false);
    held = undefined;
    expect(await gcUntil(() => kept.deref() === undefined)).toBe(true);
  });

  it("trackInstances：FinalizationRegistry 计数存活实例", async () => {
    class Thing {
      readonly data = new Array(100).fill(0);
    }
    const tracker = trackInstances(Thing);
    let things: Thing[] | undefined = [new Thing(), new Thing(), new Thing()].map((t) =>
      tracker.add(t),
    );
    const keep = tracker.add(new Thing());
    expect(tracker.created).toBe(4);
    things = undefined;
    expect(await gcUntil(() => tracker.alive === 1)).toBe(true);
    expect(things).toBeUndefined();
    expect(keep).toBeInstanceOf(Thing);
    expect(() => tracker.add({} as Thing)).toThrow(TypeError);
  });
});

describe("measureGrowth", () => {
  it("空操作噪声 < 1 MB", async () => {
    for (let i = 0; i < 3; i++) {
      const growth = await measureGrowth(() => undefined);
      expect(Math.abs(growth.total)).toBeLessThan(MB);
    }
  });

  it("留存的结果计入增长，临时分配不计", async () => {
    const kept = await measureGrowth(() => Buffer.alloc(8 * MB, 1));
    expect(kept.result.length).toBe(8 * MB);
    expect(kept.external + kept.arrayBuffers).toBeGreaterThan(7 * MB);
    const transient = await measureGrowth(() => {
      Buffer.alloc(8 * MB, 1);
      return "x".repeat(16).length;
    });
    expect(transient.total).toBeLessThan(MB);
  });
});

describe("测试文件生成", () => {
  it("makeTextFile：大小、行数、CRLF / BOM / 中文 / 末尾无换行", () => {
    const plain = makeTextFile(join(dir, "plain.txt"), 64 * 1024);
    expect(plain.bytes).toBe(statSync(plain.path).size);
    expect(plain.bytes).toBeGreaterThanOrEqual(64 * 1024);
    const text = readFileSync(plain.path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").length - 1).toBe(plain.lines);

    const fancy = makeTextFile(join(dir, "fancy.txt"), 10_000, {
      crlf: true,
      bom: true,
      cjk: true,
      trailingNewline: false,
    });
    const raw = readFileSync(fancy.path);
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = raw.subarray(3).toString("utf8");
    expect(body).toContain("中文🙂");
    expect(body.endsWith("\n")).toBe(false);
    expect(body.split("\r\n").length).toBe(fancy.lines);
  });

  it("makeSessionFile：真实 SessionManager 写出、可读回，图片按 base64 落盘", () => {
    const made = makeSessionFile(join(dir, "sessions"), {
      messages: 6,
      textBytes: 2048,
      images: 2,
      imageBytes: 256 * 1024,
    });
    expect(made.bytes).toBe(statSync(made.path).size);
    expect(made.bytes).toBeGreaterThan(2 * 256 * 1024 * (4 / 3));
    const { lines } = readSessionLines(made.path);
    expect(lines).toHaveLength(made.lines);
    const images = lines.flatMap((line) =>
      line.type === "message" && line.message.role === "user" && Array.isArray(line.message.content)
        ? line.message.content.filter((b) => b.type === "image")
        : [],
    );
    expect(images).toHaveLength(2);
  });
});
