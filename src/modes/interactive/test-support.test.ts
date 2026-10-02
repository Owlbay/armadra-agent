/** [W6-I5] 帧快照辅助：会话 id 打码两种界面语言都认。 */

import { describe, expect, it } from "vitest";
import { MemoryTerminal } from "../../tui.js";
import { snapshot } from "./test-support.js";

describe("snapshot()", () => {
  it("会话 <id> / session <id> / Session <id> / --resume <id> 都打码，其它词不动", () => {
    const terminal = new MemoryTerminal({ columns: 60, rows: 4 });
    terminal.write("会话 0b1c2d3e · 1 回合\r\n");
    terminal.write("session 9f8e7d6c · 1 turn\r\n");
    terminal.write("Session a1b2c3d4  --resume 01234567\r\n");
    terminal.write("sessions list");
    const lines = snapshot(terminal, "t").split("\n");
    expect(lines.slice(1, 5)).toEqual([
      "|会话 <id> · 1 回合",
      "|session <id> · 1 turn",
      "|Session <id>  --resume <id>",
      "|sessions list",
    ]);
  });
});
