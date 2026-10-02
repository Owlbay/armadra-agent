import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatBytes,
  previewAction,
  previewDisplayLines,
  splitRedirects,
  type PreviewOptions,
} from "./preview.js";
import type { ApprovalRequest } from "./types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ama-preview-"));
  // build/ 下 3 个文件共 30 字节（含一层子目录）
  mkdirSync(join(root, "build", "obj"), { recursive: true });
  writeFileSync(join(root, "build", "a.o"), "x".repeat(10));
  writeFileSync(join(root, "build", "b.o"), "x".repeat(10));
  writeFileSync(join(root, "build", "obj", "c.o"), "x".repeat(10));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "x.txt"), "hello");
  writeFileSync(join(root, "out.txt"), "old\n");
  writeFileSync(join(root, "a.ts"), "one\ntwo\ntwo\nthree\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function req(toolName: string, input: unknown, extra: Partial<ApprovalRequest> = {}) {
  return { requestId: "r", toolName, input, reason: "mode", ...extra } as ApprovalRequest;
}

function bash(command: string, options: Partial<PreviewOptions> = {}, reason = "mode") {
  return previewAction(req("bash", { command }, { reason: reason as ApprovalRequest["reason"] }), {
    cwd: root,
    ...options,
  });
}

describe("bash 预览", () => {
  it("rm -rf 目录：递归计数文件与字节，存在即 warn；危险原因保持 danger", () => {
    const p = bash("rm -rf build sub/x.txt nope");
    expect(p.kind).toBe("bash");
    expect(p.lines).toEqual([
      "删除 build/：目录，3 个文件，30 B",
      "删除 sub/x.txt：文件，5 B",
      "删除 nope：不存在",
    ]);
    expect(p.severity).toBe("warn");
    expect(p.affected).toEqual([
      { path: "build/", exists: true, files: 3, bytes: 30 },
      { path: "sub/x.txt", exists: true, bytes: 5 },
      { path: "nope", exists: false },
    ]);
    expect(bash("rm -rf build", {}, "dangerous").severity).toBe("danger");
    expect(bash("rm nope").severity).toBe("info");
  });

  it("超过 maxEntries 显示「> N 项」；超出时间预算给提示且不降级", () => {
    expect(bash("rm -r build", { maxEntries: 2 }).lines).toEqual(["删除 build/：目录，> 2 项"]);
    let t = 0;
    const slow = bash("rm -rf build", { now: () => (t += 150) }, "dangerous");
    expect(slow.severity).toBe("danger");
    expect(slow.lines.at(-1)).toBe("统计超时（> 200 ms），实际范围可能更大");
    expect(slow.lines[0]).toContain("统计未完成");
  });

  it("通配符与变量不展开；命中危险规则的一行在最前", () => {
    const p = bash("rm -f build/*.o $TMPDIR/x");
    expect(p.lines).toEqual([
      "删除 build/*.o：含通配符或变量，未展开，实际范围可能更大",
      "删除 $TMPDIR/x：含通配符或变量，未展开，实际范围可能更大",
    ]);
    expect(p.affected).toBeUndefined();
    expect(p.severity).toBe("warn");
    const star = bash("rm -rf *");
    expect(star.severity).toBe("danger");
    expect(star.lines[0]).toBe("危险：rm -rf on /, ~, ., .. or *");
  });

  it("重定向目标：> 覆盖、>> 追加；/dev/null 与 2>&1 忽略", () => {
    const p = bash("echo hi > out.txt 2>/dev/null && cat a.ts >>log.txt 2>&1");
    expect(p.lines).toEqual(["覆盖写入 out.txt：文件，4 B", "追加写入 log.txt：不存在"]);
    expect(splitRedirects("cmd 'a > b' >\"x y\" &>err.log").targets).toEqual([
      { word: "x y", append: false },
      { word: "err.log", append: false },
    ]);
  });

  it("mv、git clean / checkout -- / reset --hard、cd 改基准、sh -c 嵌套", () => {
    expect(bash("mv out.txt sub").lines).toEqual([
      "移动 out.txt：文件，4 B",
      "移到 sub/：目录，1 个文件，5 B（已存在的目录，移入其中）",
    ]);
    expect(bash("git clean -fd build").lines).toEqual([
      "危险：git clean -f (deletes untracked files)",
      "git clean 范围 build/：目录，3 个文件，30 B（计数含已跟踪文件，实际只删未跟踪的）",
    ]);
    expect(bash("git clean -n").lines).toEqual([]);
    expect(bash("git checkout -- a.ts").lines).toEqual(["丢弃改动 a.ts：文件，18 B"]);
    expect(bash("git reset --hard").lines).toEqual([
      "危险：git reset --hard",
      "git reset --hard：丢弃工作区与暂存区的全部未提交改动",
    ]);
    // 危险表认不出 `git -C`，预览自己标红；-C 改变路径基准
    const viaC = bash("git -C sub reset --hard && git -C sub checkout -- x.txt");
    expect(viaC.severity).toBe("danger");
    // 危险命令表现在能穿过 git 的全局选项（-C / -c …），所以和不带选项时一样带上规则行。
    expect(viaC.lines).toEqual([
      "危险：git reset --hard",
      "git reset --hard：丢弃工作区与暂存区的全部未提交改动",
      "丢弃改动 sub/x.txt：文件，5 B",
    ]);
    expect(bash("git -C sub clean -fdx").severity).toBe("danger");
    expect(bash("cd sub && rm x.txt").lines).toEqual(["删除 sub/x.txt：文件，5 B"]);
    expect(bash("sh -c 'rm -r build/obj'").lines).toEqual([
      "删除 build/obj/：目录，1 个文件，10 B",
    ]);
    expect(bash("ls | xargs rm").lines).toEqual(["rm：路径来自管道或展开，范围未知"]);
  });

  it("目标过多只列前 20 个", () => {
    const p = bash(`rm ${Array.from({ length: 25 }, (_, i) => `f${i}`).join(" ")}`);
    expect(p.lines).toHaveLength(21);
    expect(p.lines.at(-1)).toBe("… 另 5 处未列出");
  });
});

describe("write / edit / 其它", () => {
  const readSet = (...paths: string[]) => ({ depth: 0, readFiles: new Set(paths) });

  it("write：新建、覆盖已读文件、覆盖未读文件 warn、目标是目录", () => {
    const write = (path: string, readFiles: string[] = []) =>
      previewAction(req("write", { path, content: "a\nb\n" }, { context: readSet(...readFiles) }), {
        cwd: root,
      });
    expect(write("new.ts")).toEqual({
      kind: "write",
      lines: ["新建 new.ts：2 行，4 B"],
      severity: "info",
      affected: [{ path: "new.ts", exists: false }],
    });
    const read = write("out.txt", [join(root, "out.txt")]);
    expect(read.lines).toEqual(["覆盖 out.txt：1 行，4 B → 2 行，4 B"]);
    expect(read.severity).toBe("info");
    const unread = write("out.txt");
    expect(unread.lines[1]).toBe("本会话未 read 过此文件，write 会被拒绝（先 read）");
    expect(unread.severity).toBe("warn");
    expect(write("sub").lines).toEqual(["sub 是目录，write 会失败"]);
  });

  it("edit：干跑成功给每处 −/+ 与总行数；不唯一 / 未找到提前说明", () => {
    const edit = (edits: unknown, replaceAll = false) =>
      previewAction(
        req(
          "edit",
          { path: join(root, "a.ts"), edits, replaceAll },
          { context: readSet(join(root, "a.ts")) },
        ),
        { cwd: root },
      );
    const ok = edit([{ oldText: "one\n", newText: "1\n1b\n1c\n" }]);
    expect(ok.lines).toEqual(["修改 a.ts：1 处替换", "  #1 −1/+3 行", "  共 4 → 6 行"]);
    expect(ok.severity).toBe("info");
    const dup = edit([{ oldText: "two", newText: "2" }]);
    expect(dup.lines).toEqual(["修改 a.ts：干跑失败——oldText 匹配不唯一（2 处）"]);
    expect(dup.severity).toBe("warn");
    expect(edit([{ oldText: "two", newText: "2" }], true).lines[0]).toBe("修改 a.ts：2 处替换");
    expect(edit([{ oldText: "zzz", newText: "2" }]).lines).toEqual([
      "修改 a.ts：干跑失败——未找到 oldText",
    ]);
    expect(
      previewAction(req("edit", { path: "missing.ts", edits: [] }), { cwd: root }).lines,
    ).toEqual(["missing.ts 不存在或不是文件，edit 会失败"]);
  });

  it("其它工具一行摘要；显示行跳过 other 并截断", () => {
    const other = previewAction(req("canvas_write", { name: "节点\nA" }), { cwd: root });
    expect(other).toEqual({ kind: "other", lines: ["节点 ⏎ A"], severity: "info" });
    expect(previewDisplayLines(other)).toEqual([]);
    expect(previewDisplayLines(undefined)).toEqual([]);
    const many = { kind: "bash" as const, lines: ["1", "2", "3", "4"], severity: "warn" as const };
    expect(previewDisplayLines(many, 3)).toEqual(["1", "2", "… 另 2 行"]);
  });

  it("formatBytes", () => {
    expect([0, 1023, 1024, 1536, 5 * 1024 * 1024].map(formatBytes)).toEqual([
      "0 B",
      "1023 B",
      "1.0 KB",
      "1.5 KB",
      "5.0 MB",
    ]);
  });
});
