/**
 * 启动序列的晚绑定接缝：Runtime.approvals / notifier（契约 A4）、
 * SessionAssembly.onSessionReplaced 与 permissions.create 入参（契约 A5）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "../../test/helpers/bootstrap-harness.js";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import type { ApprovalBroker, HostApi } from "../host/types.js";
import { runCli } from "./bootstrap.js";
import type { Runtime } from "./runtime.js";

let home: TmpHome;
let h: Harness;

beforeEach(() => {
  home = createTmpHome();
  h = harness(home);
});
afterEach(() => {
  delete (globalThis as { __amaTestHostApi?: HostApi }).__amaTestHostApi;
  home.cleanup();
});

const run = (argv: string[]) => runCli(argv, h.deps, h.io);

/** 宿主适配器把 HostApi 交到 globalThis，测试在模式里调用它。 */
function writeCapturingHost(): void {
  home.write(
    "work/host.cjs",
    `module.exports = { hostApi: 1, create(api) { globalThis.__amaTestHostApi = api; return { id: "cap" }; } };`,
  );
}
const hostApi = (): HostApi =>
  (globalThis as { __amaTestHostApi?: HostApi }).__amaTestHostApi as HostApi;

describe("Runtime.approvals / notifier（契约 A4）", () => {
  it("setUiBroker 存起来，组装材料 uiBroker() 现取；undefined 撤下", async () => {
    const broker: ApprovalBroker = { ask: async () => "allow" };
    const seen: (ApprovalBroker | undefined)[] = [];
    h.deps.modes.print = async (runtime) => {
      const assembly = h.calls.assembly;
      seen.push(assembly?.uiBroker());
      runtime.approvals.setUiBroker(broker);
      seen.push(assembly?.uiBroker());
      runtime.approvals.setUiBroker(undefined);
      seen.push(assembly?.uiBroker());
      return 0;
    };
    expect(await run(["-p", "hi"])).toBe(0);
    expect(seen).toEqual([undefined, broker, undefined]);
  });

  it("notifier.set 接管宿主 ui.notify；set() 恢复为写 stderr", async () => {
    writeCapturingHost();
    const shown: string[] = [];
    h.deps.modes.line = async (runtime: Runtime) => {
      runtime.notifier.set((message, level) => shown.push(`${level}:${message}`));
      hostApi().ui.notify("画布已连接", "warn");
      runtime.notifier.set();
      hostApi().ui.notify("回到 stderr");
      return 0;
    };
    expect(await run(["--host", "host.cjs"])).toBe(0);
    expect(shown).toEqual(["warn:画布已连接"]);
    expect(h.err.join("")).toContain("ama: [host] 回到 stderr");
  });
});
