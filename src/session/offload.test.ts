/**
 * #170 图片卸载：活动分支上被 context_edit 改写的含图消息只留占位，getEntries / fork 原文，
 * setLeaf 换分支后回读；JSONL 字节不变。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ContentBlock, ImageBlock, UserMessage } from "../ai/types.js";
import { SessionManager } from "./manager.js";
import { migrateSessionLines } from "./migrate.js";
import { hasImages, readLineAt } from "./offload.js";
import { buildProjection } from "./projection.js";
import { appendLines, readSessionLines, writeNewSessionFile } from "./store.js";
import type { SessionEntry } from "./types.js";

const root = mkdtempSync(join(tmpdir(), "ama-offload-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
const freshDir = (): string => join(root, `s${seq++}`);

const png = (seed: number, bytes = 4096): ImageBlock => ({
  type: "image",
  mimeType: "image/png",
  data: Buffer.alloc(bytes, seed).toString("base64"),
});
const userWith = (text: string, ...images: ImageBlock[]): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }, ...images],
  timestamp: 1,
});
const imagesOf = (entry: SessionEntry | undefined): ImageBlock[] => {
  const content = entry?.type === "message" ? (entry.message as { content?: unknown }).content : [];
  return Array.isArray(content)
    ? (content as ContentBlock[]).filter((b): b is ImageBlock => b.type === "image")
    : [];
};
const edit = (m: SessionManager, targetId: string): SessionEntry =>
  m.append({
    type: "context_edit",
    targetId,
    replacement: "[image omitted]",
    reason: "image_budget",
  });

/** 已落盘：system 无，u1(图 1) → a → u2(图 2, 图 3) → 编辑 u1、u2。 */
function persisted(warn?: (message: string) => void): {
  m: SessionManager;
  u1: string;
  u2: string;
  beforeEdits: string;
} {
  const m = SessionManager.create(freshDir(), "/work", warn !== undefined ? { warn } : {});
  const u1 = m.append({ type: "message", message: userWith("one", png(1)) }).id;
  m.append({ type: "message", message: userWith("plain") });
  const u2 = m.append({ type: "message", message: userWith("two", png(2), png(3)) }).id;
  m.flush();
  const beforeEdits = m.leafId() as string;
  edit(m, u1);
  edit(m, u2);
  return { m, u1, u2, beforeEdits };
}

describe("store：行位置与写入字节", () => {
  it("readSessionLines(onLine) 的位置能读回同一行；appendLines / writeNewSessionFile 报告字节数", () => {
    const file = join(freshDir() + ".jsonl");
    const lines = [
      { type: "session", n: "中文" },
      { type: "x", id: "a" },
    ];
    const lengths = writeNewSessionFile(file, lines as never);
    expect(lengths).toEqual(lines.map((l) => Buffer.byteLength(JSON.stringify(l))));
    const written = appendLines(file, [{ type: "x", id: "b", s: "🙂" }] as never);
    const seen: unknown[] = [];
    const read = readSessionLines(file, { onLine: (_, loc) => seen.push(readLineAt(file, loc)) });
    expect(read.bytes).toBe(lengths[0]! + lengths[1]! + 2 + written);
    expect(seen).toEqual(read.lines);
    expect(readSessionLines(file).bytes).toBeUndefined();
  });
});

describe("SessionManager 图片卸载", () => {
  it("编辑后条目里的图片变成占位；投影不受影响；文件仍是原文", () => {
    const { m, u1, u2 } = persisted();
    expect(m.offloadedCount()).toBe(2);
    expect(imagesOf(m.getEntry(u1)).map((b) => b.data)).toEqual([""]);
    expect(imagesOf(m.getEntry(u2)).map((b) => b.data)).toEqual(["", ""]);
    expect(imagesOf(m.getEntry(u2))[0]?.mimeType).toBe("image/png");
    const texts = buildProjection(m.branch()).messages.map((msg) =>
      "content" in msg ? JSON.stringify(msg.content) : "",
    );
    expect(texts.filter((t) => t.includes("[image omitted]"))).toHaveLength(2);
    expect(readFileSync(m.file()!, "utf8")).toContain(png(3).data);
    m.close();
  });

  it("卸载不改共享的 ImageBlock：之前拿到的消息对象仍是原图", () => {
    const m = SessionManager.create(freshDir(), "/work");
    const image = png(7);
    const message = userWith("x", image);
    const id = m.append({ type: "message", message }).id;
    m.flush();
    edit(m, id);
    expect(image.data.length).toBeGreaterThan(0);
    expect((message.content as ContentBlock[])[1]).toBe(image);
    expect(imagesOf(m.getEntry(id))[0]?.data).toBe("");
    m.close();
  });

  it("getEntries 与 fork 是原文；entries() 是卸载后的视图", () => {
    const { m, u2 } = persisted();
    const fromFile = migrateSessionLines(readSessionLines(m.file()!).lines).entries;
    expect(m.getEntries().entries).toEqual(fromFile);
    expect(imagesOf(m.getEntries(u2).entries.find((e) => e.id === u2))).toEqual([]);
    expect(m.getEntries(m.entries()[0]!.id).entries).toEqual(fromFile.slice(1));
    expect(imagesOf(m.entries().find((e) => e.id === u2))[0]?.data).toBe("");
    const forked = m.fork(m.leafId()!);
    const forkText = readFileSync(forked.file()!, "utf8");
    for (const seed of [1, 2, 3]) expect(forkText).toContain(png(seed).data);
    // fork 出的会话同样卸载；父会话的状态不变
    expect(forked.offloadedCount()).toBe(2);
    expect(m.offloadedCount()).toBe(2);
    forked.close();
    m.close();
  });

  it("setLeaf 回到编辑之前：就地回读（之前拿到的消息对象也恢复）；回到末尾再卸载", () => {
    const { m, u1, u2, beforeEdits } = persisted();
    const end = m.leafId()!;
    const held = (m.getEntry(u2) as { message: { content: ContentBlock[] } }).message;
    m.setLeaf(beforeEdits);
    expect(m.offloadedCount()).toBe(0);
    expect(imagesOf(m.getEntry(u1))[0]?.data).toBe(png(1).data);
    expect((held.content[2] as ImageBlock).data).toBe(png(3).data);
    m.setLeaf(end);
    expect(m.offloadedCount()).toBe(2);
    expect(imagesOf(m.getEntry(u2))[1]?.data).toBe("");
    m.setLeaf(null);
    expect(m.offloadedCount()).toBe(0);
    m.close();
  });

  it("open() 读到带编辑的文件：直接卸载；修复过半行后追加的条目位置仍正确", () => {
    const { m, u1, beforeEdits } = persisted();
    const file = m.file()!;
    m.close();
    writeFileSync(file, readFileSync(file, "utf8") + '{"type":"message","id":"half', "utf8");
    const opened = SessionManager.open(file);
    expect(opened.offloadedCount()).toBe(2);
    const u3 = opened.append({ type: "message", message: userWith("three", png(4)) }).id;
    edit(opened, u3);
    expect(opened.offloadedCount()).toBe(3);
    opened.setLeaf(beforeEdits);
    expect(imagesOf(opened.getEntry(u1))[0]?.data).toBe(png(1).data);
    opened.setLeaf(u3);
    expect(imagesOf(opened.getEntry(u3))[0]?.data).toBe(png(4).data);
    opened.close();
  });

  it("open() 时编辑不在活动分支上（叶子停在编辑之前）：读入时剥掉的图片随即回读", () => {
    const { m, u1, u2, beforeEdits } = persisted();
    m.setLeaf(beforeEdits);
    const file = m.file()!;
    m.close();
    const opened = SessionManager.open(file);
    expect(opened.offloadedCount()).toBe(0);
    expect(imagesOf(opened.getEntry(u1))[0]?.data).toBe(png(1).data);
    expect(imagesOf(opened.getEntry(u2)).map((b) => b.data)).toEqual([png(2).data, png(3).data]);
    opened.close();
  });

  it("toolResult 等任何角色的含图消息都卸载；不含图的条目不受影响", () => {
    const m = SessionManager.create(freshDir(), "/work");
    m.flush();
    const tool = m.append({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [png(5)],
        isError: false,
        timestamp: 1,
      },
    });
    const text = m.append({ type: "message", message: userWith("no image") });
    expect(hasImages(tool)).toBe(true);
    expect(hasImages(text)).toBe(false);
    edit(m, tool.id);
    edit(m, text.id);
    expect(m.offloadedCount()).toBe(1);
    expect(imagesOf(m.getEntry(tool.id))[0]?.data).toBe("");
    m.close();
  });

  it("内存会话与延迟会话（未落盘）不卸载；延迟会话 flush 后卸载", () => {
    const memory = SessionManager.inMemory("/work");
    const id = memory.append({ type: "message", message: userWith("x", png(6)) }).id;
    edit(memory, id);
    expect(memory.offloadedCount()).toBe(0);
    expect(imagesOf(memory.getEntry(id))[0]?.data).toBe(png(6).data);

    const lazy = SessionManager.create(freshDir(), "/work");
    const lid = lazy.append({ type: "message", message: userWith("x", png(6)) }).id;
    edit(lazy, lid);
    expect(lazy.offloadedCount()).toBe(0);
    lazy.flush();
    expect(lazy.offloadedCount()).toBe(1);
    expect(imagesOf(lazy.getEntries().entries.find((e) => e.id === lid))[0]?.data).toBe(
      png(6).data,
    );
    lazy.close();
  });

  it("文件被外部改写：回读失败时告警、保留占位，getEntries / fork 不抛错", () => {
    const warnings: string[] = [];
    const { m, u1, beforeEdits } = persisted((message) => warnings.push(message));
    writeFileSync(m.file()!, "{}\n".repeat(10), "utf8");
    expect(imagesOf(m.getEntries().entries.find((e) => e.id === u1))[0]?.data).toBe("");
    expect(warnings).toHaveLength(2);
    m.setLeaf(beforeEdits);
    expect(imagesOf(m.getEntry(u1))[0]?.data).toBe("");
    expect(warnings).toHaveLength(2);
    m.close();
  });
});
