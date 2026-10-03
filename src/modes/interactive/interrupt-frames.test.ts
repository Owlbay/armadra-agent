/**
 * 打断并立即发送的整屏帧（zh + en）：运行中输入框有字时运行提示行带「Enter 排队 · Ctrl+X 打断并发送」，
 * 有排队插话时队列末行带「Ctrl+X 立即发送」；按 Ctrl+X 后旧回合中止、新回合立刻以「插话 + 本条」开始。
 * 更新：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive`。
 */

import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.js";
import { cleanupStarted, golden, snapshot, start, waitScreen } from "./test-support.js";

afterEach(async () => {
  setLocale("zh");
  await cleanupStarted();
});

const CTRL_X = "\x18";

for (const locale of ["zh", "en"] as const) {
  describe(`打断并发送（${locale}）`, () => {
    it("提示行 → Ctrl+X → 新回合收到「插话 + 本条」", async () => {
      setLocale(locale);
      const s = await start(
        [
          { steps: [{ text: "Working on it" }, { delayMs: 5_000 }, { text: " (never)" }] },
          { text: "OK, switching." },
        ],
        { columns: 100 },
      );
      const streaming = s.until((e) => e.type === "message_update");
      s.type("first");
      s.terminal.sendInput("\r");
      await streaming;
      s.type("also this");
      s.terminal.sendInput("\r");
      s.type("do Y instead");
      const frames: string[] = [];
      await waitScreen(s, (screen) => /Ctrl\+X (打断并发送|interrupt & send)/.test(screen), "hint");
      frames.push(snapshot(s.terminal, "draft while running"));
      const settled = s.until(
        (e) =>
          e.type === "message_end" &&
          e.message.role === "assistant" &&
          e.message.stopReason !== "aborted",
      );
      s.terminal.sendInput(CTRL_X);
      await settled;
      await s.handle.session().waitForIdle();
      s.frame();
      frames.push(snapshot(s.terminal, "after Ctrl+X"));
      const users = s.handle
        .session()
        .messages.filter((m) => m.role === "user")
        .map((m) => ({ text: m.content, origin: m.role === "user" ? m.origin : undefined }));
      expect(users).toEqual([
        { text: "first", origin: undefined },
        { text: "also this\n\ndo Y instead", origin: "interrupt" },
      ]);
      expect(s.handle.editor.isEmpty()).toBe(true);
      // 输入 token 随系统提示里的环境（平台、路径）变：只比结构
      const shot = frames.join("\n").replace(/↑[\d.]+k?/g, "↑<n>");
      golden(`${locale === "en" ? "en/" : ""}interrupt-send-100x24`, shot);
      s.handle.exit(0);
      await s.done;
    });
  });
}
