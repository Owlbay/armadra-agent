import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderData, ProviderRegistryApi } from "../ai/types.js";
import { createTextStartupUi, readOneLine } from "./startup-ui-text.js";

function setup() {
  const stdin = new PassThrough();
  const written: string[] = [];
  const ui = createTextStartupUi({ stdin, write: (text) => void written.push(text) });
  return { stdin, ui, text: () => written.join("") };
}

function registry(): ProviderRegistryApi {
  const model = (provider: string, id: string) =>
    ({ id, name: id, provider }) as ProviderData["models"][number];
  const providers = [
    { id: "openai", models: [model("openai", "gpt-5")] },
    { id: "anthropic", models: [model("anthropic", "sonnet"), model("anthropic", "haiku")] },
  ] as ProviderData[];
  return { list: () => providers } as unknown as ProviderRegistryApi;
}

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("启动期文本问答", () => {
  it("readOneLine 只消费一行，余下的退回流里；EOF 返回 undefined", async () => {
    const stdin = new PassThrough();
    const first = readOneLine(stdin);
    stdin.write("a\r\nb\nc");
    expect(await first).toBe("a");
    expect(await readOneLine(stdin)).toBe("b");
    const third = readOneLine(stdin);
    stdin.end();
    expect(await third).toBe("c");
    expect(await readOneLine(stdin)).toBeUndefined();
  });

  it("promptTrust：y 仅本次、a 记住、其它不信任", async () => {
    for (const [input, expected] of [
      ["y", { trusted: true, remember: false }],
      ["a", { trusted: true, remember: true }],
      ["", { trusted: false, remember: false }],
    ] as const) {
      const { stdin, ui, text } = setup();
      const pending = ui.promptTrust("/repo", ["/repo/.ama/hooks.json"]);
      stdin.write(`${input}\n`);
      expect(await pending).toEqual(expected);
      expect(text()).toContain("/repo/.ama/hooks.json");
    }
  });

  it("pickModel：列出全部候选，接受编号、完整值或唯一前缀", async () => {
    for (const [input, expected] of [
      ["2", "anthropic/sonnet"],
      ["anthropic/haiku", "anthropic/haiku"],
      ["openai", "openai/gpt-5"],
      ["anthropic", undefined],
      ["9", undefined],
    ] as const) {
      const { stdin, ui, text } = setup();
      const pending = ui.pickModel(registry(), "没有可用模型");
      stdin.write(`${input}\n`);
      expect(await pending).toBe(expected);
      expect(text()).toContain("没有可用模型");
      expect(text()).toContain("3. anthropic/haiku");
    }
  });

  it("pickSession：空列表直接 undefined；按修改时间倒序编号；EOF 取消", async () => {
    const { stdin, ui, text } = setup();
    expect(await ui.pickSession([])).toBeUndefined();
    const base = { file: "f", cwd: "/", createdAt: "", messageCount: 1 };
    const items = [
      { ...base, id: "old11111", modifiedAt: "2026-10-01", firstPrompt: "旧" },
      { ...base, id: "new22222", modifiedAt: "2026-10-02", name: "新" },
    ];
    let pending = ui.pickSession(items);
    stdin.write("1\n");
    expect(await pending).toBe("new22222");
    expect(text()).toMatch(/1\. new22222 {2}新\n {2}2\. old11111 {2}旧/);
    pending = ui.pickSession(items);
    stdin.end();
    expect(await pending).toBeUndefined();
  });

  it("askCwd：存在的目录返回绝对路径；不是目录或空行返回 undefined", async () => {
    dir = mkdtempSync(join(tmpdir(), "ama-text-ui-"));
    let s = setup();
    let pending = s.ui.askCwd("/gone");
    s.stdin.write(`${dir}\n`);
    expect(await pending).toBe(dir);
    s = setup();
    pending = s.ui.askCwd("/gone");
    s.stdin.write(`${join(dir, "nope")}\n`);
    expect(await pending).toBeUndefined();
    expect(s.text()).toContain("不是目录");
  });
});
