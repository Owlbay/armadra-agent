import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import { joinPrompt } from "./print-mode.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

function lines(): Record<string, unknown>[] {
  return h
    .stdout()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("print 模式", () => {
  it("text：只输出最后的助手文本，退出 0", async () => {
    h = composeHarness([{ text: "hello there" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("hello there\n");
  });

  it("text：去掉前导空行、保留首行缩进；json 的 text 原样", async () => {
    h = composeHarness([{ text: "\n\n  indented\nnext" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("  indented\nnext\n");
    h.cleanup();
    h = composeHarness([{ text: "\n \n" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("");
    h.cleanup();
    h = composeHarness([{ text: "\n\nraw" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "json"])).toBe(0);
    expect(lines()[0]).toMatchObject({ text: "\n\nraw" });
  });

  it("stdin 管道与参数拼接；两者都没有 → 2", async () => {
    h = composeHarness(undefined, { readStdin: async () => "piped text\n" });
    expect(await h.run(["-p", "question", "--model", "fake/echo"])).toBe(0);
    expect(h.fake.calls[0]?.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: "question\n\npiped text",
    });
    expect(joinPrompt(undefined, "")).toBe("");
    h.cleanup();
    h = composeHarness(undefined, { readStdin: async () => "" });
    expect(await h.run(["-p", "--model", "fake/echo"])).toBe(2);
    expect(h.stderr()).toContain("需要提示");
  });

  it("json：一个结果对象，含停止原因、用量与条目", async () => {
    h = composeHarness([{ text: "done", usage: { input: 10, output: 2, cacheRead: 30 } }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "json"])).toBe(0);
    const [result] = lines();
    expect(result).toMatchObject({ type: "result", stopReason: "stop", text: "done" });
    expect(result?.["cacheHitRate"]).toBe(0.75);
    expect((result?.["entries"] as unknown[]).length).toBeGreaterThan(2);
  });

  it("stream-json：逐事件一行，重试事件可见，message_update 无 partial", async () => {
    h = composeHarness([
      { error: { kind: "rate_limit" } },
      { error: { kind: "overloaded" } },
      { text: "Recovered after retries." },
    ]);
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    expect(
      await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "stream-json"]),
    ).toBe(0);
    const types = lines().map((e) => e["type"]);
    expect(types).toContain("auto_retry_start");
    expect(types).toContain("auto_retry_end");
    expect(types.at(-1)).toBe("agent_settled");
    expect(h.stdout()).not.toContain('"partial"');
  });

  it("最终错误 → 退出 1，stderr 给原因；工具 ask 在 print 下被拒", async () => {
    h = composeHarness([{ error: { kind: "auth" } }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(1);
    expect(h.stderr()).toMatch(/ama: .+/);
    h.cleanup();
    h = composeHarness([
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo x" } } }] },
      { text: "after" },
    ]);
    expect(await h.run(["-p", "run", "--model", "fake/echo"])).toBe(0);
    const result = h.fake.calls[1]?.context.messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({ isError: true });
  });
});
