/**
 * 第六波 bundle 级端到端（W6-Z，docs/history/wave6-plan.md §9 W6-Z 行）：走 `dist/bundle/ama.cjs`，临时 HOME。
 *
 * - `ama auth status` 没有 OAuth 条目时的输出（中英），且只读命令不建配置目录；
 * - `ama sessions trace <id> --html --now <ms>` 两次输出逐字节相同、自包含（CSP、无外链）；
 * - `AMA_LANG=en ama -p`（fake 供应商）：stderr 是英文，发给模型的 system / tools（`AMA_FAKE_RECORD`）与
 *   会话里的工具结果和 zh 逐字节相同；
 * - `ama config set / get / unset` 往返，非法值退出 3；
 * - `--memory` 开启后 fake 经 `memory` 工具写入一条，`ama memory list` / `show` 可见。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { hasBundle, runAma } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

interface RecordLine {
  system: string;
  tools: { name: string }[];
  messagesCount: number;
}

function readRecord(file: string): RecordLine[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as RecordLine);
}

/** 数据目录下全部会话文件（按文件名排序 = 按创建时间）。 */
function sessionFiles(h: TmpHome): string[] {
  const root = join(h.dataDir, "sessions");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort((a, b) => (a.split(/[\\/]/).pop()! < b.split(/[\\/]/).pop()! ? -1 : 1));
}

/** 会话里发给模型的工具结果正文。 */
function toolResultTexts(file: string): string[] {
  const texts: string[] = [];
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { role?: string; content?: string | { type: string; text?: string }[] };
    };
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    const content = entry.message.content ?? "";
    if (typeof content === "string") texts.push(content);
    else for (const block of content) if (block.type === "text") texts.push(block.text ?? "");
  }
  return texts;
}

const writeScript = {
  version: 1,
  responses: [
    { steps: [{ toolCall: { name: "write", arguments: { path: "notes.md", content: "x" } } }] },
    { text: "Done." },
  ],
};

const memoryScript = {
  version: 1,
  responses: [
    {
      steps: [
        {
          toolCall: {
            name: "memory",
            arguments: {
              command: "create",
              path: "/memories/user/prefers-pnpm.md",
              file_text:
                "---\nname: prefers-pnpm\ndescription: Use pnpm, not npm\ntype: user\n---\n\nAlways use pnpm here.\n",
            },
          },
        },
      ],
    },
    { text: "Saved." },
  ],
};

describe.skipIf(!hasBundle)("e2e：第六波（bundle 子进程）", () => {
  it("ama auth status：没有 OAuth 条目时一行说明、退出 0，不建配置目录；en 同义", async () => {
    home = createTmpHome();
    const authFile = join(home.configDir, "auth.json");
    const zh = await runAma(home, ["auth", "status"]);
    expect(zh.code).toBe(0);
    expect(zh.stdout).toBe(`${authFile}：没有 OAuth 登录\n`);
    const chatgpt = await runAma(home, ["auth", "status", "chatgpt"]);
    expect(chatgpt.code).toBe(0);
    expect(chatgpt.stdout).toBe(zh.stdout);
    const en = await runAma(home, ["auth", "status"], { env: { AMA_LANG: "en" } });
    expect(en.code).toBe(0);
    expect(en.stdout).toBe(`${authFile}: no OAuth sign-ins\n`);
    expect(existsSync(authFile)).toBe(false);
    expect(readdirSync(home.configDir)).toEqual([]);
  });

  it("ama sessions trace --html --now：两次输出逐字节相同，自包含（CSP、无外部资源）", async () => {
    home = createTmpHome();
    const run = await runAma(home, ["-p", "hello trace", "--model", "fake/echo"]);
    expect(run.code).toBe(0);
    const [file] = sessionFiles(home);
    expect(file).toBeDefined();
    const id = /_([0-9a-f]{8})-/.exec(file!)![1]!;
    const argv = ["sessions", "trace", id, "--html", "--now", "1700000000000"];
    const first = await runAma(home, argv);
    const second = await runAma(home, argv);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.stdout.length).toBeGreaterThan(1000);
    expect(second.stdout).toBe(first.stdout);
    const html = first.stdout;
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain(`content="default-src 'none'`);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script[^>]*\ssrc=|<link[^>]*\shref=|@import|url\(/i);
    // --now 固定页脚时间：换一个值输出随之变化
    const other = await runAma(home, [...argv.slice(0, -1), "1700000001000"]);
    expect(other.stdout).not.toBe(first.stdout);
  });

  it("AMA_LANG=en ama -p：stderr 英文；system / tools 与工具结果和 zh 逐字节相同", async () => {
    home = createTmpHome();
    const script = home.write("write-script.json", writeScript);
    const run = async (lang: "zh" | "en") => {
      const record = home!.path(`record-${lang}.jsonl`);
      const r = await runAma(home!, ["-p", "write notes", "--model", "fake/echo"], {
        env: { AMA_LANG: lang, AMA_FAKE_SCRIPT: script, AMA_FAKE_RECORD: record },
      });
      return { ...r, record: readRecord(record) };
    };
    const zh = await run("zh");
    const en = await run("en");
    expect(zh.code).toBe(7);
    expect(en.code).toBe(7);
    expect(zh.stdout).toBe("Done.\n");
    expect(en.stdout).toBe("Done.\n");
    expect(zh.stderr).toContain("1 次工具调用被拒：write ×1");
    expect(en.stderr).toContain("1 tool call denied: write ×1");
    expect(en.stderr).not.toMatch(/[一-鿿]/);

    expect(en.record).toHaveLength(2);
    expect(en.record).toEqual(zh.record);
    const [zhFile, enFile] = sessionFiles(home);
    const zhResults = toolResultTexts(zhFile!);
    expect(zhResults).toHaveLength(1);
    expect(zhResults[0]).not.toMatch(/[一-鿿]/);
    expect(toolResultTexts(enFile!)).toEqual(zhResults);
  });

  it("ama config set / get / unset 往返；未知键与非法值退出 3、文件不动", async () => {
    home = createTmpHome();
    const set = await runAma(home, ["config", "set", "thinkingLevel", "high"]);
    expect(set.code).toBe(0);
    const config = JSON.parse(home.read("home/.config/ama/config.json")) as Record<string, unknown>;
    expect(config["thinkingLevel"]).toBe("high");

    const get = await runAma(home, ["config", "get", "thinkingLevel", "--json"]);
    expect(get.code).toBe(0);
    expect(JSON.parse(get.stdout)).toMatchObject({
      key: "thinkingLevel",
      value: "high",
      source: "user",
    });

    const before = home.read("home/.config/ama/config.json");
    const bad = await runAma(home, ["config", "set", "thinkingLevel", "nope"]);
    expect(bad.code).toBe(3);
    const unknown = await runAma(home, ["config", "set", "ui.bogus", "1"]);
    expect(unknown.code).toBe(3);
    expect(home.read("home/.config/ama/config.json")).toBe(before);

    const unset = await runAma(home, ["config", "unset", "thinkingLevel"]);
    expect(unset.code).toBe(0);
    const after = await runAma(home, ["config", "get", "thinkingLevel", "--json"]);
    expect(JSON.parse(after.stdout)).toMatchObject({ value: "medium", source: "default" });
  });

  it("--memory：fake 经 memory 工具写入一条，ama memory list / show 可见；不开时工具表没有 memory", async () => {
    home = createTmpHome();
    const script = home.write("memory-script.json", memoryScript);
    const record = home.path("record-memory.jsonl");
    const r = await runAma(
      home,
      ["-p", "remember pnpm", "--model", "fake/echo", "--memory", "--allow", "memory(create)"],
      { env: { AMA_FAKE_SCRIPT: script, AMA_FAKE_RECORD: record } },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Saved.\n");
    expect(readRecord(record)[0]!.tools.map((t) => t.name)).toContain("memory");
    expect(existsSync(join(home.dataDir, "memory", "user", "prefers-pnpm.md"))).toBe(true);

    const list = await runAma(home, ["memory", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/prefers-pnpm \[prefers-pnpm\.md\] — Use pnpm, not npm/);
    const show = await runAma(home, ["memory", "show", "prefers-pnpm"]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("Always use pnpm here.");

    const plainRecord = home.path("record-plain.jsonl");
    const plain = await runAma(home, ["-p", "hi", "--model", "fake/echo"], {
      env: { AMA_FAKE_RECORD: plainRecord },
    });
    expect(plain.code).toBe(0);
    expect(readRecord(plainRecord)[0]!.tools.map((t) => t.name)).not.toContain("memory");
  });
});
