import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { harness, type Harness } from "../../test/helpers/bootstrap-harness.js";
import { AmaError } from "../errors.js";
import { runCli } from "./bootstrap.js";
import type { Runtime } from "./runtime.js";
import { buildStartupScreen } from "./startup-screen.js";

let home: TmpHome;
let h: Harness;

beforeEach(() => {
  home = createTmpHome();
  h = harness(home);
});
afterEach(() => home.cleanup());

const run = (argv: string[]) => runCli(argv, h.deps, h.io);
const stderr = () => h.err.join("");

/** node 脚本 Hook 命令（写入临时 .cjs）。 */
function nodeHook(name: string, source: string): string {
  const file = home.write(`scripts/${name}.cjs`, source).replace(/\\/g, "/");
  return `"${process.execPath.replace(/\\/g, "/")}" "${file}"`;
}

describe("启动序列：每个退出码", () => {
  it("0：完整启动，Runtime 字段齐全，退出时 dispose", async () => {
    home.write("home/.config/ama/config.json", {
      version: 1,
      defaultModel: "fake/echo",
      ui: { quietStartup: "normal" },
    });
    home.write("work/AGENTS.md", "rules");
    expect(await run(["-p", "hi"])).toBe(0);
    const runtime = h.calls.runtime as Runtime;
    expect(runtime.mode).toBe("print");
    expect(runtime.model.id).toBe("echo");
    expect(runtime.paths.sessionDir).toBe(join(home.dataDir, "sessions"));
    expect(runtime.resources.contextFiles.map((f) => f.content)).toEqual(["rules"]);
    expect(runtime.trust).toEqual({ trusted: false, source: "default" });
    expect(h.calls.assembly?.source).toBe("startup");
    expect(h.calls.assembly?.unattended).toBe(true);
    expect(h.calls.disposed).toBe(1);
    expect(buildStartupScreen(runtime)[1]).toContain("fake/echo");
  });

  it("1：模式抛错 / 模式未装配 / 未注入运行时", async () => {
    h.deps.modes.print = async () => {
      throw new Error("model failed");
    };
    expect(await run(["-p", "hi"])).toBe(1);
    expect(h.calls.disposed).toBe(1);
    delete h.deps.modes.line;
    expect(await run(["hi"])).toBe(1);
    expect(stderr()).toMatch(/line 尚未装配/);
    expect(await runCli(["hi"], undefined, h.io)).toBe(1);
  });

  it("2：参数错误、--provider 不带 --model、未知工具", async () => {
    expect(await run(["-p", "--mode", "rpc"])).toBe(2);
    expect(stderr()).toMatch(/ama --help/);
    expect(await run(["-p", "--provider", "fake", "hi"])).toBe(2);
    expect(stderr()).toMatch(/--provider fake 需要同时给出 --model/);
    expect(await run(["-p", "--tools", "read,nope", "hi"])).toBe(2);
    expect(stderr()).toMatch(/未知工具：nope/);
    expect(await run(["-p", "--resume"])).toBe(2);
  });

  it("3：用户配置 / profile / 项目配置 / hooks.json / --instructions", async () => {
    home.write("home/.config/ama/config.json", "{ bad");
    expect(await run(["-p", "hi"])).toBe(3);
    expect(stderr()).toMatch(/第 1 行/);
    home.write("home/.config/ama/config.json", { version: 1 });
    expect(await run(["-p", "--profile", "nope.json", "hi"])).toBe(3);
    home.write("work/.ama/config.json", { version: 1, permission: { mode: 7 } });
    expect(await run(["-p", "hi"])).toBe(3);
    home.write("work/.ama/config.json", { version: 1 });
    home.write("home/.config/ama/hooks.json", "[");
    expect(await run(["-p", "hi"])).toBe(3);
    home.write("home/.config/ama/hooks.json", { version: 1, hooks: {} });
    expect(await run(["-p", "--instructions", "missing.md", "hi"])).toBe(3);
    expect(stderr()).toMatch(/--instructions 文件不存在/);
  });

  it("4：模型不存在列候选、无 key 提示 ama auth set", async () => {
    expect(await run(["-p", "--model", "fake/nope", "hi"])).toBe(4);
    expect(stderr()).toMatch(/候选：fake\/echo/);
    delete h.keys["fake"];
    expect(await run(["-p", "--model", "fake/echo", "hi"])).toBe(4);
    expect(stderr()).toMatch(/ama auth set fake/);
    expect(stderr()).toMatch(/FAKE_API_KEY/);
    // --api-key 只配合 --model
    expect(await run(["-p", "--model", "echo", "--provider", "fake", "--api-key", "x", "hi"])).toBe(
      0,
    );
    expect(h.calls.providerInput?.cliApiKey).toEqual({
      apiKey: "x",
      modelRef: "echo",
      provider: "fake",
    });
  });

  it("5：会话不存在 / 会话 cwd 不存在", async () => {
    expect(await run(["-p", "--resume", "missing", "hi"])).toBe(5);
    expect(stderr()).toMatch(/会话不存在/);
    expect(await run(["-p", "--resume", "gone-cwd", "hi"])).toBe(5);
  });

  it("6：宿主模块加载失败 / create 抛错；SessionStart Hook 退出码 2", async () => {
    expect(await run(["-p", "--host", "nope.cjs", "hi"])).toBe(6);
    home.write(
      "work/bad-host.cjs",
      `module.exports = { hostApi: 1, create() { throw new Error("x"); } };`,
    );
    expect(await run(["-p", "--host", "bad-host.cjs", "hi"])).toBe(6);
    home.write("home/.config/ama/hooks.json", {
      version: 1,
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: nodeHook("deny", `process.stderr.write("禁止"); process.exit(2);`),
              },
            ],
          },
        ],
      },
    });
    expect(await run(["-p", "hi"])).toBe(6);
    expect(stderr()).toMatch(/SessionStart Hook 阻止启动：禁止/);
    expect(h.calls.disposed).toBe(1);
  });

  it("78：宿主 API 版本不匹配", async () => {
    home.write(
      "work/v2-host.cjs",
      `module.exports = { hostApi: 2, create() { return { id: "x" }; } };`,
    );
    expect(await run(["-p", "--host", "v2-host.cjs", "hi"])).toBe(78);
  });
});

describe("启动序列：编排细节", () => {
  it("--tools-preset / --codemode 叠加在项目级之后进入 Runtime.config", async () => {
    home.write("home/.config/ama/config.json", { version: 1, codemode: { inlineBudget: 500 } });
    home.write("work/.ama/config.json", {
      version: 1,
      tools: { preset: "minimal" },
      codemode: { mode: "off" },
    });
    expect(await run(["-p", "hi"])).toBe(0);
    expect((h.calls.runtime as Runtime).config.tools?.preset).toBe("minimal");
    expect((h.calls.runtime as Runtime).config.codemode).toEqual({
      mode: "off",
      inlineBudget: 500,
    });
    expect(await run(["-p", "--tools-preset", "codemode", "--codemode", "only", "hi"])).toBe(0);
    // 旧名 codemode 是 codemode-only 的别名，进 Runtime.config 时已是规范名
    expect((h.calls.runtime as Runtime).config.tools?.preset).toBe("codemode-only");
    expect((h.calls.runtime as Runtime).config.codemode).toEqual({
      mode: "only",
      inlineBudget: 500,
    });
  });

  it("profile 展开为参数（命令行优先）、trustProject、authEnv、缺省 header", async () => {
    const hostFile = home.write(
      "host/host.cjs",
      `module.exports = { hostApi: 1, create(api) { api.instructions.add({ kind: "text", text: "canvas" }); api.tools.disable("task"); return { id: "armadra" }; } };`,
    );
    const sessionDir = home.path("profile-sessions");
    const authFile = home.path("profile-auth.json");
    const profile = home.write("profile.json", {
      version: 1,
      host: hostFile,
      sessionDir,
      authFile,
      authEnv: false,
      trustProject: true,
    });
    expect(await run(["-p", "--profile", profile, "hi"])).toBe(0);
    const runtime = h.calls.runtime as Runtime;
    expect(runtime.paths.sessionDir).toBe(sessionDir);
    expect(runtime.trust.source).toBe("flag");
    expect(runtime.host?.adapter.id).toBe("armadra");
    expect(runtime.tools.list()).not.toContain("task");
    expect(runtime.config.ui?.quietStartup).toBe("header");
    expect(h.calls.assembly?.host.instructions).toEqual([{ kind: "text", text: "canvas" }]);
    expect(h.calls.providerInput).toMatchObject({ authFile, authEnv: false });
    expect(await run(["-p", "--profile", profile, "--session-dir", "mine", "hi"])).toBe(0);
    expect((h.calls.runtime as Runtime).paths.sessionDir).toBe(join(home.cwd, "mine"));
  });

  it("模式判定：非 TTY → line；TTY → interactive；TERM=dumb → line", async () => {
    expect(await run(["hi"])).toBe(0);
    expect((h.calls.runtime as Runtime).mode).toBe("line");
    let interactive = 0;
    h.deps.modes.interactive = async () => {
      interactive++;
      return 0;
    };
    h.io = { ...h.io, stdinIsTTY: true, stdoutIsTTY: true };
    expect(await run([])).toBe(0);
    expect(interactive).toBe(1);
    h.io = { ...h.io, env: { ...h.io.env, TERM: "dumb" } };
    expect(await run([])).toBe(0);
    expect(interactive).toBe(1);
  });

  it("终端初始化失败自动降级为 line", async () => {
    h.io = { ...h.io, stdinIsTTY: true, stdoutIsTTY: true };
    h.deps.modes.interactive = async () => {
      throw new AmaError("terminal_init_failed", "no raw mode");
    };
    expect(await run([])).toBe(0);
    expect(stderr()).toMatch(/降级为行式界面/);
    expect((h.calls.runtime as Runtime).mode).toBe("interactive");
  });

  it("续会话取最后 model_change 与思考级别；SessionStart additionalContext 交给会话", async () => {
    h.entries.push(
      {
        type: "model_change",
        id: "e1",
        parentId: null,
        timestamp: "",
        provider: "fake",
        modelId: "echo",
      },
      {
        type: "thinking_level_change",
        id: "e2",
        parentId: "e1",
        timestamp: "",
        thinkingLevel: "high",
      },
    );
    home.write("home/.config/ama/hooks.json", {
      version: 1,
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: nodeHook(
                  "ctx",
                  `console.log(JSON.stringify({ additionalContext: "from hook" }));`,
                ),
              },
            ],
          },
        ],
      },
    });
    expect(await run(["-p", "--continue", "hi"])).toBe(0);
    expect(h.calls.assembly?.source).toBe("resume");
    expect(h.calls.runtime?.thinkingLevel).toBe("high");
    expect(h.calls.assembly?.sessionStartContext()).toBe("from hook");
  });

  it("项目级 Hook 需要信任；--trust 后加载", async () => {
    const marker = home.path("ran.txt").replace(/\\/g, "/");
    home.write("work/.ama/hooks.json", {
      version: 1,
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: nodeHook(
                  "mark",
                  `require("fs").writeFileSync(${JSON.stringify(marker)}, "1");`,
                ),
              },
            ],
          },
        ],
      },
    });
    expect(await run(["-p", "hi"])).toBe(0);
    expect(stderr()).toMatch(/项目未信任/);
    expect(h.calls.runtime?.hooks.list()).toHaveLength(0);
    expect(await run(["-p", "--trust", "hi"])).toBe(0);
    expect(h.calls.runtime?.hooks.list()).toHaveLength(1);
    writeFileSync(marker, "", { flag: "a" });
    expect(home.read("ran.txt")).toBe("1");
  });

  it("hook_executed 与 session_start / session_shutdown 发到宿主总线", async () => {
    const log = home.path("events.json").replace(/\\/g, "/");
    home.write(
      "work/host.cjs",
      `const fs = require("fs"); const seen = [];
module.exports = { hostApi: 1, create(api) {
  for (const n of ["session_start", "hook_executed", "session_shutdown"]) api.events.on(n, () => { seen.push(n); fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(seen)); });
  return { id: "obs" };
} };`,
    );
    home.write("home/.config/ama/hooks.json", {
      version: 1,
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: nodeHook("ok", "process.exit(0)") }] },
        ],
      },
    });
    expect(await run(["-p", "--host", "host.cjs", "hi"])).toBe(0);
    expect(JSON.parse(home.read("events.json"))).toEqual([
      "session_start",
      "hook_executed",
      "session_shutdown",
    ]);
  });
});
