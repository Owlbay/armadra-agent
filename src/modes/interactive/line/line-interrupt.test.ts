/**
 * line 模式的打断并发送：运行中输入 `/interrupt <文本>` → 中止当前回合，立即以「排队的插话 + 本条」开新回合；
 * 空闲时就是普通提示；缺文本给用法。
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../../test/helpers/compose-harness.js";
import { emptyArgs } from "../../../cli/args.js";
import { runLineMode } from "./line-mode.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

async function until(check: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5000) throw new Error(`timeout: ${label}\n${h.stdout()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("行式界面：/interrupt", () => {
  it("运行中：中止当前回合，新回合收到「插话 + 本条」；之后照常收下一行", async () => {
    h = composeHarness([
      { steps: [{ text: "working" }, { delayMs: 5_000 }, { text: "never" }] },
      { text: "switched" },
      { text: "idle reply" },
    ]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    const stdin = Object.assign(new PassThrough(), { setRawMode: () => undefined, isTTY: true });
    const done = runLineMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin, raw: true },
    );
    stdin.write("start\r");
    await until(() => h.stdout().includes("working"), "streaming");
    stdin.write("note first\r");
    await until(() => h.stdout().includes("↳ steer：note first"), "steer");
    stdin.write("/interrupt\r");
    await until(() => h.stderr().includes("用法：/interrupt <文本>"), "usage");
    stdin.write("/interrupt do B now\r");
    await until(() => h.stdout().includes("switched"), "switched");
    expect(h.stdout()).toContain("已打断，立即发送：do B now");
    expect(h.fake.calls).toHaveLength(2);
    expect(h.fake.calls[1]?.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: "note first\n\ndo B now",
    });
    const users = runtime.session.messages.filter((m) => m.role === "user");
    expect(users.at(-1)).toMatchObject({ origin: "interrupt" });
    expect(h.stdout()).not.toContain("never");
    // 空闲时 /interrupt 就是普通提示
    stdin.write("/interrupt hello\r");
    await until(() => h.stdout().includes("idle reply"), "idle");
    expect(runtime.session.messages.filter((m) => m.role === "user").at(-1)).toMatchObject({
      content: "hello",
    });
    stdin.write("\x04");
    expect(await done).toBe(0);
    await runtime.dispose();
  });
});
