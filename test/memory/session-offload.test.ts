/**
 * #170 图片卸载的内存守护：被 context_edit 改写的旧图 base64 不再常驻，getEntries / fork / setLeaf
 * 仍能拿回原文。断言只用 WeakRef + 显式 GC 与 GC 后的堆增长（test/helpers/memory.ts）。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ContentBlock, ImageBlock } from "../../src/ai/types.js";
import { SessionManager } from "../../src/session/manager.js";
import { migrateSessionLines } from "../../src/session/migrate.js";
import { readSessionLines } from "../../src/session/store.js";
import type { SessionEntry } from "../../src/session/types.js";
import {
  forceGc,
  gcUntil,
  makeSessionFile,
  measureGrowth,
  sampleMemory,
} from "../helpers/memory.js";

const MB = 1024 * 1024;
const root = mkdtempSync(join(tmpdir(), "ama-mem-offload-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const imagesOf = (entry: SessionEntry | undefined): ImageBlock[] => {
  const content = entry?.type === "message" ? (entry.message as { content?: unknown }).content : [];
  return Array.isArray(content)
    ? (content as ContentBlock[]).filter((b): b is ImageBlock => b.type === "image")
    : [];
};
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const withImages = (m: SessionManager): string[] =>
  m
    .entries()
    .filter((e) => imagesOf(e).length > 0)
    .map((e) => e.id);
const editAll = (m: SessionManager, ids: readonly string[]): void => {
  for (const targetId of ids) {
    m.append({
      type: "context_edit",
      targetId,
      replacement: "[image omitted]",
      reason: "image_budget",
    });
  }
};
/** 在单独的函数里取 WeakRef，测试体不持有 block 的强引用。 */
const weakImages = (m: SessionManager): WeakRef<ImageBlock>[] =>
  m.entries().flatMap((e) => imagesOf(e).map((b) => new WeakRef(b)));

describe("#170 降级后释放旧图 base64", () => {
  it("6 张 1.5 MB 图各被 image_budget 改写：block 全部可回收，堆 + 堆外下降 ≥ 5 份 base64", async () => {
    const { path } = makeSessionFile(join(root, "six"), {
      messages: 12,
      images: 6,
      imageBytes: 1.5 * MB,
    });
    const m = SessionManager.open(path);
    const refs = weakImages(m);
    expect(refs).toHaveLength(6);
    const base64 = refs[0]!.deref()!.data.length;
    const ids = withImages(m);
    forceGc();
    const before = sampleMemory();
    editAll(m, ids);
    expect(m.offloadedCount()).toBe(6);
    expect(await gcUntil(() => refs.every((r) => r.deref() === undefined))).toBe(true);
    const after = sampleMemory();
    const drop = before.heapUsed + before.external - (after.heapUsed + after.external);
    expect(drop).toBeGreaterThanOrEqual(5 * base64);
    m.close();
  });

  it("getEntries 与直接读文件的条目深度相等；fork 的新文件含全部 base64", () => {
    const { path } = makeSessionFile(join(root, "fork"), {
      messages: 8,
      images: 3,
      imageBytes: 256 * 1024,
      edits: "image_budget",
    });
    const m = SessionManager.open(path);
    expect(m.offloadedCount()).toBe(3);
    const fromFile = migrateSessionLines(readSessionLines(path).lines).entries;
    expect(m.getEntries().entries).toEqual(fromFile);
    const forked = m.fork(m.leafId()!);
    const text = readFileSync(forked.file()!, "utf8");
    for (const entry of fromFile) {
      for (const image of imagesOf(entry)) expect(text).toContain(image.data);
    }
    forked.close();
    m.close();
  });

  it("setLeaf 回到编辑之前：data 长度与 sha256 恢复；回到末尾再卸载", () => {
    const { path } = makeSessionFile(join(root, "leaf"), {
      messages: 6,
      images: 2,
      imageBytes: 512 * 1024,
    });
    const plain = SessionManager.open(path);
    const expected = new Map(
      withImages(plain).map((id) => [id, imagesOf(plain.getEntry(id)).map((b) => sha(b.data))]),
    );
    const beforeEdits = plain.leafId()!;
    editAll(plain, [...expected.keys()]);
    const end = plain.leafId()!;
    for (const id of expected.keys()) expect(imagesOf(plain.getEntry(id))[0]?.data).toBe("");
    plain.setLeaf(beforeEdits);
    for (const [id, hashes] of expected) {
      const images = imagesOf(plain.getEntry(id));
      expect(images[0]!.data.length).toBeGreaterThan(512 * 1024);
      expect(images.map((b) => sha(b.data))).toEqual(hashes);
    }
    plain.setLeaf(end);
    expect(plain.offloadedCount()).toBe(expected.size);
    plain.close();
  });

  it("带 6 条编辑的 24 MB 会话：open 的增长 < 文本字节 + 2 MB（图片不常驻）", async () => {
    const textBytes = 4 * 1024;
    const messages = 40;
    const { path, bytes } = makeSessionFile(join(root, "big"), {
      messages,
      textBytes,
      images: 6,
      imageBytes: 3 * MB,
      edits: "image_budget",
    });
    expect(bytes).toBeGreaterThan(24 * MB);
    SessionManager.open(path).close(); // 热身：模块、JIT
    const growth = await measureGrowth(() => SessionManager.open(path), { warmup: false });
    expect(growth.result.offloadedCount()).toBe(6);
    expect(growth.total).toBeLessThan(messages * textBytes + 2 * MB);
    growth.result.close();
  });
});
