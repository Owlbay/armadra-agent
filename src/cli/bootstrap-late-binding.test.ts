/**
 * 启动序列的晚绑定接缝：Runtime.approvals / notifier（契约 A4）、
 * SessionAssembly.onSessionReplaced 与 permissions.create 入参（契约 A5）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "../../test/helpers/bootstrap-harness.js";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import type { AgentSession } from "../agent/types.js";
import type { ApprovalBroker, HostApi } from "../host/types.js";
import { runCli } from "./bootstrap.js";
import type { RuntimeDeps } from "./deps.js";
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

describe("SessionAssembly.onSessionReplaced 与 permissions.create 入参（契约 A5）", () => {
  /** 与 harness 的初始会话同形状的替身。 */
  function replacement(id: string, cwd: string): { session: AgentSession; disposed: () => number } {
    let disposed = 0;
    const session = {
      state: {
        sessionId: id,
        sessionFile: `${cwd}/${id}.jsonl`,
        cwd,
        model: { provider: "fake", id: "echo" },
        permissionMode: "plan",
        isStreaming: true,
      },
      steer: async () => undefined,
      dispose: async () => {
        disposed++;
      },
    };
    return { session: session as unknown as AgentSession, disposed: () => disposed };
  }

  it("替换后 HostApi.session.*、Hook 公共字段、退出 dispose 都跟随新会话", async () => {
    writeCapturingHost();
    const log = home.path("stop-input.json").replace(/\\/g, "/");
    const script = home
      .write(
        "scripts/stop.cjs",
        `let raw = ""; process.stdin.on("data", (c) => (raw += c)); process.stdin.on("end", () => require("fs").writeFileSync(${JSON.stringify(log)}, raw));`,
      )
      .replace(/\\/g, "/");
    home.write("home/.config/ama/hooks.json", {
      version: 1,
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: `"${process.execPath.replace(/\\/g, "/")}" "${script}"` },
            ],
          },
        ],
      },
    });
    const next = replacement("sess-2", home.cwd);
    const seen: unknown[] = [];
    h.deps.modes.line = async (runtime) => {
      seen.push(hostApi().session.id());
      h.calls.assembly?.onSessionReplaced(next.session);
      seen.push(hostApi().session.id(), hostApi().session.file());
      seen.push(await hostApi().messages.sendUser("来自画布"));
      seen.push(runtime.session.state.sessionId);
      await runtime.hooks.run("Stop", {});
      return 0;
    };
    expect(await run(["--host", "host.cjs"])).toBe(0);
    // [#165] Runtime.session 也跟随新会话
    expect(seen).toEqual(["sess-1", "sess-2", `${home.cwd}/sess-2.jsonl`, "queued", "sess-2"]);
    expect(JSON.parse(home.read("stop-input.json"))).toMatchObject({
      hookEventName: "Stop",
      sessionId: "sess-2",
      sessionFile: `${home.cwd}/sess-2.jsonl`,
      permissionMode: "plan",
      depth: 0,
    });
    expect(next.disposed()).toBe(1);
    expect(h.calls.disposed).toBe(0);
  });

  it("permissions.create 收到会话 cwd 与用户级 builtinDeny", async () => {
    const inputs: Parameters<RuntimeDeps["permissions"]["create"]>[0][] = [];
    const original = h.deps.permissions.create;
    h.deps.permissions.create = (input) => {
      inputs.push(input);
      return original(input);
    };
    expect(await run(["-p", "hi"])).toBe(0);
    home.write("home/.config/ama/config.json", {
      version: 1,
      permission: { builtinDeny: ["read(**/.ssh/**)"] },
    });
    home.write("work/.ama/config.json", { version: 1, permission: { builtinDeny: false } });
    expect(await run(["-p", "hi"])).toBe(0);
    expect(inputs[0]).toEqual({
      mode: "default",
      rules: [],
      unattended: true,
      cwd: home.cwd,
    });
    expect(inputs[1]?.builtinDeny).toEqual(["read(**/.ssh/**)"]);
    expect(inputs[1]?.cwd).toBe(home.cwd);
  });
});
