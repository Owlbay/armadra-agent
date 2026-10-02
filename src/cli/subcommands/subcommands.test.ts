import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import type { ProviderData, ProviderRegistryApi } from "../../ai/types.js";
import type { SessionListItem } from "../../session/types.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { defaultIo, main } from "../main.js";
import { runDoctor } from "./doctor.js";
import { MODELS_ACTIONS, MODELS_USAGE, runModels } from "./models.js";
import { runSessions } from "./sessions.js";

let home: TmpHome;
let out: string[];
let err: string[];
let stdin: string;

function io(extra: Partial<CliIo> = {}): Partial<CliIo> {
  return {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: home.env,
    cwd: home.cwd,
    readStdin: async () => stdin,
    ...extra,
  };
}

/** 不经 main（main 缺省会装上组装根）：直接以「未装配」调用子命令。 */
const fullIo = (extra: Partial<CliIo> = {}): CliIo => ({ ...defaultIo(), ...io(extra) });

const ama = (argv: string[], deps?: RuntimeDeps) =>
  main(argv, { io: io(), processHooks: false, ...(deps !== undefined ? { deps } : {}) });

beforeEach(() => {
  home = createTmpHome();
  out = [];
  err = [];
  stdin = "";
});
afterEach(() => home.cleanup());

const PROVIDER: ProviderData = {
  id: "fake",
  name: "Fake",
  api: "fake",
  baseUrl: "http://fake",
  envKeys: ["FAKE_API_KEY"],
  requiresApiKey: true,
  builtin: true,
  models: [
    {
      id: "echo",
      name: "Echo",
      provider: "fake",
      api: "fake",
      input: ["text"],
      reasoning: false,
      maxTokens: 100,
      contextWindow: 128_000,
    },
  ],
};

function stubDeps(): RuntimeDeps {
  const registry: ProviderRegistryApi = {
    list: () => [PROVIDER],
    get: () => PROVIDER,
    findModel: (ref) =>
      ref === "fake/echo"
        ? { ok: true, model: PROVIDER.models[0]!, provider: PROVIDER }
        : { ok: false, reason: "not_found", candidates: ["fake/echo"] },
    resolveApiKey: async () => ({
      apiKey: "SECRET-VALUE",
      source: "auth-file",
      origin: "/x/auth.json",
    }),
    getApi: () => ({
      id: "fake",
      stream: () => {
        const message = {
          role: "assistant" as const,
          content: [],
          api: "fake",
          provider: "fake",
          model: "echo",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: "stop" as const,
          timestamp: 0,
        };
        return {
          result: async () => message,
          [Symbol.asyncIterator]: async function* () {},
        } as never;
      },
    }),
  };
  const items: SessionListItem[] = [
    {
      id: "abcdef123456",
      file: "/s/a.jsonl",
      cwd: "/w",
      createdAt: "2026-10-01T00:00:00.000Z",
      modifiedAt: "2026-10-02T01:02:03.000Z",
      firstPrompt: "fix   the bug",
      messageCount: 4,
    },
  ];
  return {
    providers: { create: () => registry },
    sessions: {
      open: () => {
        throw new Error("unused");
      },
      list: async () => items,
      show: async () => ({ item: items[0]!, entries: [] }),
      prune: async ({ dryRun }) => ({ moved: dryRun ? ["/s/old.jsonl"] : [] }),
    },
    tools: { create: () => ({}) as never },
    permissions: { create: () => ({}) as never },
    session: { create: () => ({}) as never },
    modes: {},
  };
}

describe("ama --help / --version", () => {
  it("输出完整用法", async () => {
    expect(await ama(["--help"])).toBe(0);
    const text = out.join("");
    expect(text).toContain("用法：ama");
    expect(text).toContain("--permission-mode");
    expect(text).toContain("ama doctor");
    out = [];
    expect(await ama(["-v"])).toBe(0);
    expect(out.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("ama auth", () => {
  it("set 从 stdin 读 key 写 0600；list 不输出 key；remove", async () => {
    stdin = "sk-very-secret\n";
    expect(await ama(["auth", "set", "anthropic"])).toBe(0);
    const path = join(home.configDir, "auth.json");
    expect(JSON.parse(home.read("home/.config/ama/auth.json")).providers.anthropic.apiKey).toBe(
      "sk-very-secret",
    );
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(out.join("")).not.toContain("sk-very-secret");
    out = [];
    expect(await ama(["auth", "list"])).toBe(0);
    expect(out.join("")).toMatch(/anthropic\s+key/);
    expect(out.join("")).not.toContain("sk-very-secret");
    expect(await ama(["auth", "remove", "anthropic"])).toBe(0);
    expect(await ama(["auth", "remove", "anthropic"])).toBe(1);
  });

  it("空 stdin / 缺 provider / 未知动作 → 2；--auth-file", async () => {
    expect(await ama(["auth", "set", "x"])).toBe(2);
    expect(await ama(["auth", "set"])).toBe(2);
    expect(await ama(["auth", "frob"])).toBe(2);
    stdin = "k2";
    expect(await ama(["auth", "set", "x", "--auth-file", "custom.json"])).toBe(0);
    expect(JSON.parse(home.read("work/custom.json")).providers.x.apiKey).toBe("k2");
  });
});

describe("ama doctor（临时 HOME）", () => {
  it("输出层级、信任、key 来源（不含值）、hook 列表、终端", async () => {
    home.write("home/.config/ama/config.json", {
      version: 1,
      providers: { proxy: { apiKey: "$PROXY_KEY" } },
    });
    home.write(
      "home/.config/ama/auth.json",
      { version: 1, providers: { anthropic: { apiKey: "sk-hidden" } } },
      0o600,
    );
    home.write("home/.config/ama/hooks.json", {
      version: 1,
      hooks: {
        PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
      },
    });
    home.write("work/.ama/config.json", { version: 1, permission: { allow: ["bash(*)"] } });
    home.write("work/.ama/hooks.json", {
      version: 1,
      hooks: { Stop: [{ hooks: [{ type: "command", command: "evil" }] }] },
    });
    home.write("work/AGENTS.md", "x");
    expect(
      await runDoctor([], fullIo({ env: { ...home.env, OPENAI_API_KEY: "sk-env" } }), undefined),
    ).toBe(0);
    const text = out.join("");
    expect(text).toContain("配置层级");
    expect(text).toContain(join(home.configDir, "config.json"));
    expect(text).toMatch(/收紧：.*allow/);
    expect(text).toMatch(/未信任（缺省/);
    expect(text).toContain(join(home.cwd, ".ama", "hooks.json"));
    expect(text).toMatch(/anthropic\s+auth-file（literal）/);
    expect(text).toMatch(/proxy\s+config（env-ref）/);
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toMatch(/user\s+PreToolUse \[bash\] → \.\/guard\.sh/);
    expect(text).toMatch(/未信任，跳过：/);
    expect(text).not.toContain("evil");
    expect(text).toContain("终端");
    expect(text).not.toContain("sk-hidden");
    expect(text).not.toContain("sk-env");
  });

  it("--trust 后列出项目级 Hook；注入注册表时按供应商给来源", async () => {
    home.write("work/.ama/hooks.json", {
      version: 1,
      hooks: { Stop: [{ hooks: [{ type: "command", command: "proj-stop" }] }] },
    });
    expect(await ama(["doctor", "--trust"], stubDeps())).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/project\s+Stop → proj-stop/);
    expect(text).toMatch(/fake\s+auth-file（\/x\/auth\.json）/);
    expect(text).not.toContain("SECRET-VALUE");
  });

  it("配置错误 → 列出并以 3 结束", async () => {
    home.write("home/.config/ama/config.json", "{");
    expect(await ama(["doctor"])).toBe(3);
    expect(out.join("")).toContain("✗");
  });
});

describe("ama models / sessions（依赖注入）", () => {
  it("models list / check", async () => {
    expect(await ama(["models", "list"], stubDeps())).toBe(0);
    expect(out.join("")).toMatch(/fake\/echo\s+ctx 128k/);
    expect(out.join("")).not.toContain("SECRET-VALUE");
    expect(await ama(["models", "check", "fake/echo"], stubDeps())).toBe(0);
    expect(out.join("")).toMatch(/fake\/echo 可用/);
    expect(await ama(["models", "check", "fake/none"], stubDeps())).toBe(4);
    expect(await runModels(["list"], fullIo(), undefined)).toBe(1);
    expect(await ama(["models", "check"], stubDeps())).toBe(2);
  });

  it("models 动作表（W3-C0）：用法文本由表生成且与改表前一致；未知动作与选项 → 2", async () => {
    expect(Object.keys(MODELS_ACTIONS)).toEqual([
      "list",
      "check",
      "discover",
      "cache-probe",
      "refresh-catalog",
    ]);
    expect(MODELS_USAGE).toMatch(
      /^用法：ama models list \[--provider <id>\]\n {6}ama models check <provider\/id>\n {6}ama models discover /,
    );
    expect(await ama(["models", "--help"], stubDeps())).toBe(0);
    expect(out.join("")).toContain(MODELS_USAGE);
    expect(await ama(["models", "frob"], stubDeps())).toBe(2);
    expect(await ama(["models", "toString"], stubDeps())).toBe(2);
    expect(await ama(["models", "list", "--json"], stubDeps())).toBe(2);
  });

  it("sessions list / show / prune", async () => {
    expect(await ama(["sessions", "list"], stubDeps())).toBe(0);
    expect(out.join("")).toMatch(/abcdef12 {2}2026-10-02 01:02:03 {5}4 条 {2}fix the bug/);
    expect(await ama(["sessions", "show", "abc"], stubDeps())).toBe(0);
    expect(out.join("")).toContain("文件：/s/a.jsonl");
    out = [];
    expect(await ama(["sessions", "prune", "--dry-run"], stubDeps())).toBe(0);
    expect(out.join("")).toContain("将移到 trash：/s/old.jsonl");
    expect(await ama(["sessions", "prune", "--older-than", "x"], stubDeps())).toBe(2);
    expect(await runSessions(["list"], fullIo(), undefined)).toBe(1);
  });
});
