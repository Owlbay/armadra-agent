/**
 * [W6-I1] CLI 与子命令的英文界面抽样（docs/wave6-plan.md §9 W6-I1 验收）：`ama --help`、`ama providers
 * add / list / channels`、几个用法错误与退出码说明。其余测试缺省钉 zh，zh 断言不在这里。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { ApiRegistry } from "../../ai/apis/api.js";
import { writeModelsDevCache } from "../../ai/providers/models-dev-cache.js";
import { trimModelsDev } from "../../ai/providers/models-dev.js";
import { messagesFor, setLocale } from "../../i18n/index.js";
import { buildProviderRegistry } from "../compose-providers.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { describeExitCode } from "../exit-codes.js";
import { defaultIo, main } from "../main.js";
import { buildStartupScreen } from "../startup-screen.js";
import { runProviders } from "./providers.js";

const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;

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
  vi.unstubAllGlobals();
  setLocale("zh");
});

function io(env: Record<string, string> = {}): CliIo {
  return {
    ...defaultIo(),
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { ...home.env, ...env },
    cwd: home.cwd,
    readStdin: async () => "",
  };
}

const en = (argv: string[]) =>
  main(argv, { io: io({ AMA_LANG: "en", AMA_SHOW_FAKE: "1" }), processHooks: false });

describe("ama --help", () => {
  it("AMA_LANG=en 输出英文帮助，zh 仍是原文", async () => {
    expect(await en(["--help"])).toBe(0);
    const text = out.join("");
    expect(text).toBe(messagesFor("en").cli.help);
    expect(text).toMatch(/^Usage: ama \[options\] \[prompt\]\n/);
    expect(text).toContain("--permission-mode <mode>     default | auto-edit | plan | auto");
    expect(text).toContain("8 -p reached a budget limit");
    expect(CJK.test(text)).toBe(false);
    out = [];
    expect(await main(["--help"], { io: io({ AMA_LANG: "zh" }), processHooks: false })).toBe(0);
    expect(out.join("")).toMatch(/^用法：ama \[选项\] \[提示\]\n/);
  });

  it("--lang en 写在参数里也生效", async () => {
    const base = io();
    const env: Record<string, string | undefined> = { ...base.env };
    delete env["AMA_LANG"];
    expect(
      await main(["--lang", "en", "--help"], { io: { ...base, env }, processHooks: false }),
    ).toBe(0);
    expect(out.join("")).toMatch(/^Usage: ama /);
  });

  it("两种语言的帮助列出同一批选项与子命令", () => {
    const flags = (text: string) =>
      [...text.matchAll(/(?:^|\s)(--[a-z][a-z-]*|ama [a-z]+(?: [a-z-]+)?)/g)].map((m) => m[1]);
    const zhFlags = new Set(flags(messagesFor("zh").cli.help));
    const enFlags = new Set(flags(messagesFor("en").cli.help));
    for (const f of zhFlags) expect(enFlags, f).toContain(f);
  });
});

describe("用法错误与说明", () => {
  it("取值不合法、未知子命令、缺参数：英文报错 + 英文用法提示，退出码 2", async () => {
    expect(await en(["stats", "--by", "hour"])).toBe(2);
    expect(err.join("")).toBe(
      "ama: --by must be one of day | week | month | provider | channel | model | project (got hour)\n" +
        "(see ama --help for usage)\n",
    );
    err = [];
    expect(await en(["models", "frob"])).toBe(2);
    expect(err.join("")).toContain("ama: Unknown models subcommand: frob\n");
    err = [];
    expect(await en(["sessions", "export"])).toBe(2);
    expect(err.join("")).toContain("ama: ama sessions export needs <id>\n");
    err = [];
    expect(await en(["stats", "--project", "x", "--all"])).toBe(2);
    expect(err.join("")).toContain("--project and --all cannot be used together");
  });

  it("子命令用法文本与退出码说明", async () => {
    expect(await en(["stats", "--help"])).toBe(0);
    expect(out.join("")).toMatch(/^Usage: ama stats /);
    out = [];
    expect(await en(["models", "--help"])).toBe(0);
    expect(out.join("")).toMatch(
      /^Usage: ama models list \[--provider <id>\]\n {7}ama models check <provider\/id>\n/,
    );
    expect(out.join("")).toContain("ama models refresh-catalog (old name of refresh)");
    setLocale("en");
    expect(describeExitCode(8)).toBe(
      "-p reached a budget limit (--max-turns / --max-cost / limits)",
    );
    expect(describeExitCode(42)).toBe("Unknown exit code");
    setLocale("zh");
    expect(describeExitCode(8)).toBe("-p 到达预算上限（--max-turns / --max-cost / limits）");
  });

  it("启动画面的纯文本行", () => {
    setLocale("en");
    const lines = buildStartupScreen(
      {
        config: {},
        trust: { trusted: true, source: "flag" },
        resources: { contextFiles: [], skills: [], prompts: [], instructions: [] },
        model: { provider: "fake", id: "echo" },
        thinkingLevel: "medium",
        hooks: { list: () => [] },
        host: undefined,
        paths: { cwd: "/w" },
        warnings: ["x"],
      } as unknown as Parameters<typeof buildStartupScreen>[0],
      "normal",
    );
    expect(lines.slice(1)).toEqual([
      "Model: fake/echo · thinking medium",
      "Directory: /w · trusted (command line)",
      "Warnings: 1 (see ama doctor)",
    ]);
    expect(lines[0]).toMatch(/^ama \S+ · Enter send · Esc interrupt/);
  });
});

describe("ama providers（英文）", () => {
  const SAMPLE = JSON.parse(
    readFileSync(join(process.cwd(), "test/fixtures/models-dev/api-sample.json"), "utf8"),
  ) as unknown;
  const LISTING = [
    { id: "kimi-k2.5", supported_endpoint_types: ["openai", "openai-response", "anthropic"] },
    { id: "grok-4.7", supported_endpoint_types: ["openai-response"] },
    { id: "deepseek-flash" },
  ];
  const deps: Pick<RuntimeDeps, "providers"> = {
    providers: {
      create: (input) =>
        buildProviderRegistry(input, {
          env: { RELAY_KEY: "sk-relay" },
          apis: new ApiRegistry(),
          includeFake: false,
          probeLocal: false,
        }),
    },
  };

  it("add（不探测）、list、channels、remove 的输出是英文", async () => {
    writeModelsDevCache(home.dataDir, {
      version: 2,
      url: "https://models.dev/api.json",
      fetchedAt: "2999-01-01T00:00:00.000Z",
      providers: trimModelsDev(SAMPLE),
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/models")) return Response.json({ data: LISTING });
      return new Response("not found", { status: 404 });
    });
    setLocale("en");
    const env = { RELAY_KEY: "sk-relay" };
    const add = ["add", "relay", "--base-url", "https://relay.example/v1"];
    expect(await runProviders([...add, "--key-env", "RELAY_KEY", "--yes"], io(env), deps)).toBe(0);
    const added = out.join("");
    expect(added).toContain("relay: found 3 models (");
    expect(added).toContain(
      "Candidate channels: chat (openai-completions https://relay.example/v1)",
    );
    expect(added).toMatch(
      /\nWill write .*config\.json: relay new channels chat, responses, messages, 3 new models/,
    );
    expect(added).toMatch(/Wrote .*config\.json\n/);
    expect(added).toContain('Try: ama -p "hi" --model relay/');

    out = [];
    expect(await runProviders(["list"], io(env), deps)).toBe(0);
    const listed = out.join("");
    expect(listed).toMatch(/relay {2}custom · 3 channels · 3 models · key \$RELAY_KEY/);
    expect(listed).toMatch(
      /@chat {2}openai-completions {2}https:\/\/relay\.example\/v1 {2}\d+ models? · key/,
    );
    out = [];
    expect(await runProviders(["channels", "relay"], io(env), deps)).toBe(0);
    expect(out.join("")).toContain("@chat (default)  chat  openai-completions");
    out = [];
    expect(await runProviders(["remove", "relay"], io(env), deps)).toBe(0);
    expect(out.join("")).toMatch(/^Removed relay from .*config\.json \(previous file backed up/);
    expect(await runProviders(["remove", "relay"], io(env), deps)).toBe(1);
    expect(err.join("")).toContain("ama: no provider relay\n");
    expect(CJK.test(out.join("") + err.join(""))).toBe(false);
  });
});
