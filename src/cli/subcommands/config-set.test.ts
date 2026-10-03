import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { setLocale } from "../../i18n/index.js";
import type { CliIo } from "../deps.js";
import { main } from "../main.js";
import { runConfigEdit } from "./config-set.js";

let home: TmpHome;
let out: string[];
let err: string[];
beforeEach(() => {
  home = createTmpHome();
  out = [];
  err = [];
});
afterEach(() => {
  home.cleanup();
  setLocale("zh");
});

const userPath = (): string => join(home.configDir, "config.json");
const projectPath = (): string => join(home.cwd, ".ama", "config.json");

function io(env: Record<string, string> = {}, tty = false): CliIo {
  return {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    env: { ...home.env, AMA_NO_LOCAL_PROBE: "1", ...env },
    cwd: home.cwd,
    readStdin: async () => "",
  };
}

function ama(argv: string[], env: Record<string, string> = {}): Promise<number> {
  return main(argv, { processHooks: false, io: io(env) });
}

const stdout = (): string => out.join("");

describe("ama config set / get / unset", () => {
  it("writes the user file and reads it back", async () => {
    expect(await ama(["config", "set", "ui.theme", "light"])).toBe(0);
    expect(stdout()).toContain("ui.theme = light（用户级）");
    expect(JSON.parse(readFileSync(userPath(), "utf8")).ui).toEqual({ theme: "light" });
    // first write lays out the config dir like `ama init`
    expect(existsSync(join(home.configDir, "config.schema.json"))).toBe(true);
    out = [];
    expect(await ama(["config", "get", "ui.theme"])).toBe(0);
    expect(stdout()).toBe("ui.theme = light（user；重启）\n");
    out = [];
    expect(await ama(["config", "get", "thinkingLevel", "--json"])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      key: "thinkingLevel",
      value: "medium",
      source: "default",
      apply: "now",
      prefix: true,
      project: "deny",
    });
    out = [];
    expect(await ama(["config", "unset", "ui.theme"])).toBe(0);
    expect(stdout()).toContain("已恢复 ui.theme（用户级），现为 dark");
    expect(JSON.parse(readFileSync(userPath(), "utf8")).ui).toBeUndefined();
  });

  it("exit 3 for unknown keys, invalid values and refused project writes; files untouched", async () => {
    expect(await ama(["config", "set", "ui.theme", "light"])).toBe(0);
    const before = readFileSync(userPath(), "utf8");
    expect(await ama(["config", "set", "ui.nope", "1"])).toBe(3);
    expect(await ama(["config", "get", "ui.nope"])).toBe(3);
    expect(await ama(["config", "set", "ui.theme", "neon"])).toBe(3);
    expect(await ama(["config", "set", "retry.maxRetries", "lots"])).toBe(3);
    expect(await ama(["config", "set", "tools.disabled", "bash"])).toBe(3);
    expect(readFileSync(userPath(), "utf8")).toBe(before);
    expect(await ama(["config", "set", "permission.mode", "full-auto", "--project"])).toBe(3);
    expect(await ama(["config", "set", "cache.warming", "idle", "--project"])).toBe(3);
    expect(existsSync(projectPath())).toBe(false);
    expect(err.join("")).toContain("项目级");
    expect(await ama(["config", "set", "foo"])).toBe(2);
  });

  it("--project tightens; --json-value sets lists", async () => {
    expect(await ama(["config", "set", "permission.mode", "plan", "--project"])).toBe(0);
    expect(JSON.parse(readFileSync(projectPath(), "utf8"))).toEqual({
      version: 1,
      permission: { mode: "plan" },
    });
    expect(await ama(["config", "set", "tools.disabled", '["bash"]', "--json-value"])).toBe(0);
    expect(JSON.parse(readFileSync(userPath(), "utf8")).tools).toEqual({ disabled: ["bash"] });
    out = [];
    // user level is now hidden by the project's plan
    expect(await ama(["config", "set", "permission.mode", "auto-edit"])).toBe(0);
    // 回执第一行是刚写入的值与写入层，第二行是覆盖来源与生效值
    expect(stdout()).toBe(
      "permission.mode = auto-edit（已写入用户级）\n当前仍被 project（plan）覆盖，生效值为 plan\n",
    );
  });

  it("set 被环境变量覆盖：第一行写入的值与写入层，第二行覆盖来源与生效值；get 仍显示生效值与真实来源", async () => {
    expect(await ama(["config", "set", "ui.language", "en"], { AMA_LANG: "zh" })).toBe(0);
    expect(stdout()).toBe(
      "ui.language = en（已写入用户级）\n当前仍被 AMA_LANG（zh）覆盖，生效值为 zh\n",
    );
    expect(JSON.parse(readFileSync(userPath(), "utf8")).ui).toEqual({ language: "en" });
    out = [];
    expect(await ama(["config", "get", "ui.language"], { AMA_LANG: "zh" })).toBe(0);
    expect(stdout()).toContain("ui.language = zh（env AMA_LANG");
    out = [];
    // 没被覆盖时回执不变
    expect(await ama(["config", "set", "ui.theme", "light"], { AMA_LANG: "zh" })).toBe(0);
    expect(stdout()).toBe("ui.theme = light（用户级）\n");
  });

  it("set 被覆盖时的回执（en）", async () => {
    setLocale("en");
    expect(await runConfigEdit("set", ["ui.theme", "light"], io({ AMA_LANG: "en" }))).toBe(0);
    out = [];
    expect(await runConfigEdit("set", ["ui.language", "zh"], io({ AMA_LANG: "en" }))).toBe(0);
    expect(stdout()).toBe(
      "ui.language = zh (written to user)\nStill overridden by AMA_LANG (en); the effective value is en\n",
    );
  });

  it("full-auto needs --yes off a TTY and a confirmation on a TTY", async () => {
    expect(await ama(["config", "set", "permission.mode", "full-auto"])).toBe(3);
    expect(err.join("")).toContain("--yes");
    expect(existsSync(userPath())).toBe(false);
    const questions: string[] = [];
    const no = await runConfigEdit("set", ["permission.mode", "full-auto"], io({}, true), {
      confirm: async (q) => (questions.push(q), false),
    });
    expect(no).toBe(3);
    expect(existsSync(userPath())).toBe(false);
    const yes = await runConfigEdit("set", ["permission.mode", "full-auto"], io({}, true), {
      confirm: async () => true,
    });
    expect(yes).toBe(0);
    expect(questions[0]).toContain("Bypass");
    expect(await ama(["config", "set", "permission.mode", "default"])).toBe(0);
    expect(await ama(["config", "set", "permission.mode", "full-auto", "--yes"])).toBe(0);
    expect(JSON.parse(readFileSync(userPath(), "utf8")).permission).toEqual({ mode: "full-auto" });
  });

  it("get / list never create the config dir", async () => {
    const configDir = join(home.root, "fresh", "ama");
    const env = { AMA_CONFIG_DIR: configDir };
    expect(await ama(["config", "get", "ui.theme"], env)).toBe(0);
    expect(await ama(["config", "list"], env)).toBe(0);
    expect(existsSync(configDir)).toBe(false);
  });
});

describe("ama config list", () => {
  it("lists panel settings with sources; prefix, --all and --json", async () => {
    home.write("home/.config/ama/config.json", { version: 1, ui: { markdown: false } });
    expect(await ama(["config", "list", "ui."], { AMA_ASCII: "1" })).toBe(0);
    const text = stdout();
    expect(text).toContain("ui.markdown = false（user；即时）");
    expect(text).toContain("ui.ascii = 1（env AMA_ASCII；重启）");
    expect(text).not.toContain("defaultModel");
    out = [];
    expect(await ama(["config", "list", "permission", "--all", "--json"])).toBe(0);
    const keys = (JSON.parse(stdout()) as { key: string }[]).map((r) => r.key);
    expect(keys).toContain("permission.allow");
    expect(keys).toContain("permission.mode");
  });

  it("speaks English with --lang en", async () => {
    setLocale("en");
    expect(await ama(["config", "set", "ui.theme", "light"], { AMA_LANG: "en" })).toBe(0);
    expect(stdout()).toContain("ui.theme = light (user)");
  });
});
