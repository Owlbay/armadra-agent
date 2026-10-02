/**
 * 终端界面视觉设计 v1 的整屏帧黄金（§5.3）：启动头、工具层级、提示、运行中动词、面板、ASCII。
 * 更新：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive src/tui`，逐个审阅 diff。
 */

import { afterEach, describe, it } from "vitest";
import { composeHarness } from "../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { cleanupStarted, golden, snapshot, start, started } from "./test-support.js";

afterEach(cleanupStarted);

/** 建 harness 并把 HOME 指向临时根，让会话目录显示为 `~/work`（黄金与机器无关）。 */
function harnessWithTildeCwd(script: FakeResponse[]): void {
  const h = composeHarness(script, { stdinIsTTY: true, stdoutIsTTY: true });
  (h.io.env as Record<string, string>)["HOME"] = h.home.root;
  started.h = h;
}

describe("启动头", () => {
  for (const columns of [80, 40]) {
    it(`normal ${columns}x24：≥ 56 列画框，更窄去框去键列`, async () => {
      harnessWithTildeCwd([]);
      started.h!.home.write("work/AGENTS.md", "# rules\n");
      const s = await start([], {
        columns,
        keepHarness: true,
        quietStartup: "normal",
        argv: ["--trust"],
      });
      golden(`startup-normal-${columns}x24`, snapshot(s.terminal, "startup normal"));
      s.handle.exit(0);
      await s.done;
    });
  }

  it("header 80x24：一行头", async () => {
    const s = await start([], { quietStartup: "header" });
    golden("header-quiet-80x24", snapshot(s.terminal, "startup header"));
    s.handle.exit(0);
    await s.done;
  });
});
