import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import {
  assistantEntry,
  usageOf,
  userEntry,
  writeFixtureSession,
} from "../session/test-support.js";
import { parseArgs, type ParsedArgs } from "./args.js";
import type { CliIo } from "./deps.js";
import { applyFromOption } from "./from-prompt.js";

let h: ComposeHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

/** 1×1 PNG。 */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function seed(harness: ComposeHarness): void {
  writeFixtureSession(join(harness.home.dataDir, "sessions"), {
    id: "f0f0f0f0-0000",
    cwd: harness.home.cwd,
    start: new Date("2026-10-01T08:00:00Z"),
    entries: [
      userEntry("第一条：列出文件"),
      assistantEntry("ok", usageOf(1, 1)),
      userEntry([
        { type: "text", text: "第二条：描述这张图" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ]),
      assistantEntry("ok", usageOf(1, 1)),
    ],
  });
}

const args = (argv: string[]): ParsedArgs => {
  const parsed = parseArgs(argv);
  if (parsed.kind !== "run") throw new Error("subcommand");
  return parsed.args;
};

describe("--from", () => {
  it("解析：--from 是带值选项，可与 -p、--model 组合", () => {
    expect(args(["-p", "--from", "abc#2", "--model", "x/y"]).from).toBe("abc#2");
    expect(args(["--from=abc"]).from).toBe("abc");
    expect(() => args(["--from"])).toThrow(/需要一个值/);
  });

  it("-p --from <id>#1：用那条消息的文本作提示（fake/echo 回显）", async () => {
    h = composeHarness();
    seed(h);
    expect(await h.run(["-p", "--from", "f0f0f0f0#1", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout().trim()).toBe("第一条：列出文件");
  });

  it("-p --from <id>（缺省最后一条）带上图片，命令行提示接在后面；临时图片运行后删除", async () => {
    h = composeHarness();
    seed(h);
    expect(await h.run(["-p", "--from", "f0f0f0f0", "--model", "fake/echo", "更简短些"])).toBe(0);
    const call = h.fake.calls.at(-1)!;
    const user = call.context.messages.findLast((m) => m.role === "user")!;
    const content = user.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content.find((b) => b.type === "text")?.text).toBe("第二条：描述这张图\n\n更简短些");
    expect(content.find((b) => b.type === "image")?.data).toBe(PNG);
  });

  it("编号越界 → 退出码 2；会话不存在 → 5", async () => {
    h = composeHarness();
    seed(h);
    expect(await h.run(["-p", "--from", "f0f0f0f0#7", "--model", "fake/echo"])).toBe(2);
    expect(h.stderr()).toContain("只有 2 条用户消息");
    expect(await h.run(["-p", "--from", "nosuch", "--model", "fake/echo"])).toBe(5);
  });

  it("交互模式只带文本并提示；rpc 不支持", () => {
    h = composeHarness();
    seed(h);
    const err: string[] = [];
    const io = { ...h.io, stderr: (t: string) => void err.push(t) } as CliIo;
    const paths = {
      sessionDir: join(h.home.dataDir, "sessions"),
      cwd: h.home.cwd,
      configDir: h.home.configDir,
      dataDir: h.home.dataDir,
    };
    const result = applyFromOption(
      args(["--from", "f0f0f0f0"]),
      { mode: "interactive", paths },
      io,
    );
    expect(result.context.prompt).toBe("第二条：描述这张图");
    expect(result.context.args.images).toEqual([]);
    expect(err.join("")).toContain("1 张图片");
    expect(() => applyFromOption(args(["--from", "f0f0f0f0"]), { mode: "rpc", paths }, io)).toThrow(
      /rpc/,
    );
    const print = applyFromOption(args(["-p", "--from", "f0f0f0f0"]), { mode: "print", paths }, io);
    const [image] = print.context.args.images;
    expect(existsSync(image!)).toBe(true);
    print.cleanup();
    expect(existsSync(image!)).toBe(false);
  });
});
