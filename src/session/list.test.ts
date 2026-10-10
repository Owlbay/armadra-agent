/**
 * 流式会话列表（docs/history/memory-plan.md D6、§2.4、[M-C] 测试 1）：对 test/fixtures 下全部 `.jsonl` 与真实写出的
 * 大会话，新旧实现返回的 `SessionListItem[]` 深度相等；并钉住几条具体口径。
 */

import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeSessionFile } from "../../test/helpers/memory.js";
import {
  FIXTURES,
  fixtureFiles,
  legacyListSessionItems,
} from "../../test/helpers/session-legacy.js";
import { listSessionItems } from "./list.js";
import { SessionManager } from "./manager.js";
import type { SessionListItem } from "./types.js";

const root = mkdtempSync(join(tmpdir(), "ama-list-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** 全部 fixture 拷进一个目录（文件名带来源子目录，避免重名）。 */
function corpusDir(): string {
  const dir = join(root, "corpus");
  mkdirSync(dir, { recursive: true });
  for (const file of fixtureFiles()) {
    const name = relative(FIXTURES, file).split(sep).join("-");
    copyFileSync(file, join(dir, name));
  }
  return dir;
}

const byId = (items: SessionListItem[], id: string) => items.find((item) => item.id === id);

describe("listSessionItems：新旧口径一致", () => {
  const dir = corpusDir();
  const items = listSessionItems(dir);

  it("fixture 全集深度相等", () => {
    expect(items).toEqual(legacyListSessionItems(dir));
    expect(items.length).toBeGreaterThan(10);
  });

  it("口径：改名取最后一次、leaf 不算条目、system 不计数、firstPrompt 截 200", () => {
    const renamed = byId(items, "s-renames");
    expect(renamed?.name).toBe("最终名字");
    expect(renamed?.messageCount).toBe(4);
    expect(renamed?.firstPrompt).toHaveLength(200);
    expect(renamed?.firstPrompt?.startsWith("第一条提示 ")).toBe(true);
  });

  it("口径：其它程序写的行退回解析；CRLF；末尾半行忽略；缺 LF 的完整末行计入", () => {
    expect(byId(items, "s-foreign")).toMatchObject({
      name: "foreign name",
      messageCount: 3,
      firstPrompt: "foreign first",
    });
    expect(byId(items, "s-crlf")).toMatchObject({ name: "crlf", messageCount: 2 });
    expect(byId(items, "s-half")?.messageCount).toBe(2);
    expect(byId(items, "s-nolf")?.messageCount).toBe(2);
    expect(byId(items, "s-blank")?.firstPrompt).toBe("after blanks");
    expect(byId(items, "s-header-only")?.messageCount).toBe(0);
  });

  it("子 Agent 会话标记；fork（第一条不是任务记录）不标", () => {
    expect(byId(items, "s-sub")?.subagent).toBe(true);
    expect(byId(items, "s-fork")?.subagent).toBeUndefined();
  });

  it("坏文件整份跳过：中间坏行、写到一半的行、version ≠ 1、重复的头、坏 leaf、空文件", () => {
    for (const id of ["s-corrupt", "s-trunc", "s-v2", "s-dup", "s-badleaf"]) {
      expect(byId(items, id)).toBeUndefined();
    }
    const files = items.map((item) => basename(item.file));
    expect(files).not.toContain("sessions-empty.jsonl");
    expect(files).not.toContain("rpc-prompt.out.jsonl");
  });
});

describe("listSessionItems：真实写出的会话", () => {
  it("多块长行、中文、图片、改名与 leaf 追加后与旧实现相等", () => {
    const dir = join(root, "made");
    const made = makeSessionFile(dir, {
      messages: 9,
      textBytes: 150_000,
      images: 2,
      imageBytes: 300_000,
    });
    makeSessionFile(dir, { messages: 3, textBytes: 64 });
    const manager = SessionManager.open(made.path);
    try {
      manager.setName("名字");
      manager.setName("名字 2");
    } finally {
      manager.close();
    }
    appendFileSync(made.path, `{"type":"leaf","id":null}\n`);
    expect(readFileSync(made.path, "utf8")).toContain('"type":"session_info"');
    const items = listSessionItems(dir);
    expect(items).toEqual(legacyListSessionItems(dir));
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.file === made.path)).toMatchObject({
      name: "名字 2",
      messageCount: 9,
    });
  });

  it("目录不存在 → 空列表", () => {
    expect(listSessionItems(join(root, "nope"))).toEqual([]);
  });
});
