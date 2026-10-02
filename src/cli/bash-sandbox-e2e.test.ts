/**
 * [S2] 组装到底：`sandbox.bash: auto` 时 bash 工具与权限管线拿到同一份设定——无人值守（`-p`）的 default
 * 模式下，沙箱内命令免审批并真的经沙箱运行；`sandbox: false` 照常审批（无人值守拒绝）。本机没有能限制
 * 写入的沙箱时跳过。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { resolveBashSandbox } from "../sandbox/bash.js";
import { osSandboxStatus } from "../sandbox/detect.js";

const status = osSandboxStatus("auto");
const usable = status.kind === "sandbox-exec" || status.kind === "bwrap";

let h: ComposeHarness | undefined;
afterEach(() => h?.cleanup());

function script(args: Record<string, unknown>) {
  return [{ steps: [{ toolCall: { name: "bash", arguments: args } }] }, { text: "done" }];
}

describe.skipIf(!usable)(`组装：bash 沙箱（${status.kind}）`, () => {
  const bashSandbox = () => resolveBashSandbox({ bash: "auto" }, { status });

  it("default 模式无人值守：沙箱内命令放行并经沙箱运行", async () => {
    h = composeHarness(script({ command: "echo hi > made.txt" }));
    const code = await h.run(["-p", "go", "--model", "fake/echo"], { bashSandbox: bashSandbox() });
    expect(code).toBe(0);
    expect(existsSync(join(h.home.cwd, "made.txt"))).toBe(true);
    const result = JSON.stringify(h.fake.calls.at(-1)?.context.messages.at(-1));
    expect(result).not.toContain("unattended");
  });

  it("sandbox:false 走正常审批：无人值守拒绝", async () => {
    h = composeHarness(script({ command: "echo hi > made.txt", sandbox: false }));
    await h.run(["-p", "go", "--model", "fake/echo"], { bashSandbox: bashSandbox() });
    expect(existsSync(join(h.home.cwd, "made.txt"))).toBe(false);
    expect(JSON.stringify(h.fake.calls.at(-1)?.context.messages.at(-1))).toContain("unattended");
  });

  it("从用户级配置 sandbox.bash: auto 生效；项目级写 bash: off 关不掉", async () => {
    h = composeHarness(script({ command: "echo hi > made.txt" }));
    h.home.write("home/.config/ama/config.json", { version: 1, sandbox: { bash: "auto" } });
    h.home.write("work/.ama/config.json", { version: 1, sandbox: { bash: "off" } });
    const code = await h.run(["-p", "go", "--model", "fake/echo", "--trust"]);
    expect(code).toBe(0);
    expect(existsSync(join(h.home.cwd, "made.txt"))).toBe(true);
  });

  it("沙箱关闭时照旧：无人值守拒绝", async () => {
    h = composeHarness(script({ command: "echo hi > made.txt" }));
    await h.run(["-p", "go", "--model", "fake/echo"]);
    expect(existsSync(join(h.home.cwd, "made.txt"))).toBe(false);
  });
});
