/**
 * 界面语言的选择与接入（docs/wave6-plan.md §5.2；[W6-C0]）：`--lang`、`AMA_LANG`、用户级 / 项目级 /
 * profile 的 `ui.language`、SDK `language`。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { createDefaultApiRegistry } from "../ai/apis/api.js";
import { FakeProvider } from "../ai/fake/fake-provider.js";
import { validateConfig, validateProfile } from "../config/schema.js";
import { getLocale, setLocale } from "../i18n/index.js";
import { createAgentSession, createRuntime } from "../sdk.js";
import { parseArgs } from "./args.js";
import { main, peekUserLanguage } from "./main.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
  setLocale("zh");
});

/** 不带 AMA_LANG 的环境（测试进程本身钉了 zh）。 */
function envWithout(extra: Record<string, string> = {}): Record<string, string> {
  home ??= createTmpHome();
  const env: Record<string, string> = { ...home.env, AMA_NO_LOCAL_PROBE: "1", ...extra };
  delete env["AMA_LANG"];
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) delete env[name];
  return { ...env, ...extra };
}

function io(env: Record<string, string>) {
  return { stdout: () => undefined, stderr: () => undefined, env, cwd: home?.cwd ?? "." };
}

describe("参数", () => {
  it("--lang zh|en 进 ParsedArgs，其余取值报用法错误", () => {
    const parsed = parseArgs(["--lang", "en", "hi"]);
    expect(parsed.kind === "run" && parsed.args.lang).toBe("en");
    const inline = parseArgs(["--lang=zh"]);
    expect(inline.kind === "run" && inline.args.lang).toBe("zh");
    expect(() => parseArgs(["--lang", "fr"])).toThrow(/--lang/);
  });

  it("子命令名之前的 --lang 交给子命令一起走", () => {
    expect(parseArgs(["--lang", "en", "doctor", "--json"])).toEqual({
      kind: "subcommand",
      name: "doctor",
      argv: ["--json"],
      lang: "en",
    });
    expect(parseArgs(["--lang=zh", "sessions", "list"])).toMatchObject({
      kind: "subcommand",
      name: "sessions",
      lang: "zh",
    });
  });

  it("--memory / --no-memory 是一对开关，同时出现报错", () => {
    const on = parseArgs(["--memory"]);
    expect(on.kind === "run" && on.args.memory).toBe(true);
    const off = parseArgs(["--no-memory"]);
    expect(off.kind === "run" && off.args.memory).toBe(false);
    expect(() => parseArgs(["--memory", "--no-memory"])).toThrow(
      "--memory 与 --no-memory 不能同时使用",
    );
  });

  it("memory 登记为子命令（W6-M 实现前报尚未提供，退出码 2）", async () => {
    const err: string[] = [];
    const code = await main(["memory", "list"], {
      io: { ...io(envWithout({ AMA_LANG: "zh" })), stderr: (t: string) => void err.push(t) },
      processHooks: false,
    });
    expect(code).toBe(2);
    expect(err.join("")).toContain("ama memory：当前版本尚未提供");
  });
});

describe("main 定语言", () => {
  it("--lang 生效；AMA_LANG 优先于 --lang", async () => {
    await main(["--lang", "en", "--version"], { io: io(envWithout()), processHooks: false });
    expect(getLocale()).toBe("en");
    await main(["--lang", "en", "--version"], {
      io: io(envWithout({ AMA_LANG: "zh" })),
      processHooks: false,
    });
    expect(getLocale()).toBe("zh");
  });

  it("用户级 ui.language 优先于 LANG；读不到 / 写错当未设", async () => {
    const env = envWithout({ LANG: "en_US.UTF-8" });
    home?.write("home/.config/ama/config.json", { version: 1, ui: { language: "zh" } });
    expect(peekUserLanguage(env)).toBe("zh");
    setLocale("en");
    await main(["--version", "--help"], { io: io(env), processHooks: false });
    expect(getLocale()).toBe("zh");
    home?.write("home/.config/ama/config.json", "{ not json");
    expect(peekUserLanguage(env)).toBeUndefined();
    home?.write("home/.config/ama/config.json", { version: 1, ui: { language: "fr" } });
    expect(peekUserLanguage(env)).toBeUndefined();
  });

  it("什么都没有时是 en；LANG=zh_CN 时是 zh", async () => {
    await main(["--version", "--help"], { io: io(envWithout()), processHooks: false });
    expect(getLocale()).toBe("en");
    await main(["--version", "--help"], {
      io: io(envWithout({ LANG: "zh_CN.UTF-8" })),
      processHooks: false,
    });
    expect(getLocale()).toBe("zh");
  });
});

describe("配置与 profile", () => {
  it("ui.language 只接受 auto / zh / en", () => {
    expect(validateConfig({ version: 1, ui: { language: "en" } })).toEqual([]);
    expect(validateConfig({ version: 1, ui: { language: "fr" } })).toMatchObject([
      { severity: "error", path: "ui.language" },
    ]);
  });

  it("profile.language 只接受 zh / en", () => {
    expect(validateProfile({ version: 1, language: "zh" })).toEqual([]);
    expect(validateProfile({ version: 1, language: "auto" })).toMatchObject([
      { severity: "error", path: "language" },
    ]);
  });

  it("bootstrap 合并后按项目级 ui.language 补定（无 AMA_LANG / --lang 时）", async () => {
    const env = envWithout({ LANG: "zh_CN.UTF-8" });
    home?.write("work/.ama/config.json", { version: 1, ui: { language: "en" } });
    const fake = new FakeProvider();
    const apis = createDefaultApiRegistry();
    apis.register(fake.api);
    setLocale("zh");
    await createRuntime({
      cwd: home?.cwd ?? ".",
      env,
      model: "fake/echo",
      unattended: true,
      trust: true,
      compose: { apis, probeLocal: false },
    });
    expect(getLocale()).toBe("en");
  });

  it("SDK language：createRuntime 与 createAgentSession 都定语言", async () => {
    const env = envWithout();
    const fake = new FakeProvider();
    const apis = createDefaultApiRegistry();
    apis.register(fake.api);
    await createRuntime({
      cwd: home?.cwd ?? ".",
      env,
      model: "fake/echo",
      unattended: true,
      language: "en",
      compose: { apis, probeLocal: false },
    });
    expect(getLocale()).toBe("en");
    await createAgentSession({ model: "fake/echo", apis, language: "zh" });
    expect(getLocale()).toBe("zh");
  });
});
