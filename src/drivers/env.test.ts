import { describe, expect, it } from "vitest";
import { BUILTIN_PROVIDERS } from "../ai/providers/builtin.js";
import { buildChildEnv, isStrippedEnvKey } from "./env.js";

/** 真值表：变量名 → 是否缺省剥离（D16）。 */
const TRUTH: [string, boolean][] = [
  ["ANTHROPIC_API_KEY", true],
  ["anthropic_api_key", true],
  ["OPENAI_API_KEY", true],
  ["GEMINI_API_KEY", true],
  ["GOOGLE_API_KEY", true],
  ["DEEPSEEK_API_KEY", true],
  ["OPENROUTER_API_KEY", true],
  ["CODEX_API_KEY", true],
  ["ANTHROPIC_AUTH_TOKEN", true],
  ["ANTHROPIC_BASE_URL", true],
  ["OPENAI_BASE_URL", true],
  ["MY_PROXY_BASE_URL", true],
  ["AMA_API_KEY_ANTHROPIC", true],
  ["AMA_DATA_DIR", true],
  ["AMA_CONFIG_DIR", true],
  ["AMA_API_KEY_MYRELAY", true],
  ["PATH", false],
  ["HOME", false],
  ["USERPROFILE", false],
  ["LANG", false],
  ["LC_ALL", false],
  ["TERM", false],
  ["SSH_AUTH_SOCK", false],
  ["HTTPS_PROXY", false],
  ["HTTP_PROXY", false],
  ["NO_PROXY", false],
  ["CLAUDE_CODE_OAUTH_TOKEN", false],
  ["CODEX_HOME", false],
  ["CLAUDE_CONFIG_DIR", false],
  ["AMA", false],
  ["AI_AGENT", false],
  ["GITHUB_TOKEN", false],
];

describe("buildChildEnv（子进程环境清理真值表）", () => {
  it.each(TRUTH)("%s → 剥离 %s", (name, stripped) => {
    expect(isStrippedEnvKey(name)).toBe(stripped);
    const out = buildChildEnv({ [name]: "v" }, "claude", undefined);
    expect(name in out).toBe(!stripped);
  });

  it("Armadra 终端节点的身份变量剥离，askpass 保留", () => {
    const out = buildChildEnv(
      {
        PATH: "/bin",
        ARMADRA_NODE_ID: "n1",
        ARMADRA_SESSION_ID: "s1",
        ARMADRA_CANVAS_CONTROL: "1",
        ARMADRA_ENDPOINT_FILE: "/x/endpoint",
        armadra_hook_token: "t",
        ARMADRA_ASKPASS_SOCKET: "/x/askpass.sock",
      },
      "claude",
      undefined,
    );
    expect(out).toEqual({ PATH: "/bin", ARMADRA_ASKPASS_SOCKET: "/x/askpass.sock" });
  });

  it("内置供应商表里每个 envKeys 都剥离", () => {
    for (const provider of BUILTIN_PROVIDERS)
      for (const key of provider.envKeys ?? []) expect(isStrippedEnvKey(key)).toBe(true);
  });

  it("agents.<id>.env.passthrough 显式放回（不分大小写），只对该 Agent 生效", () => {
    const env = { ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "ok", PATH: "/bin" };
    const config = { claude: { env: { passthrough: ["anthropic_api_key"] } } };
    expect(buildChildEnv(env, "claude", config)).toEqual({ ANTHROPIC_API_KEY: "sk", PATH: "/bin" });
    expect(buildChildEnv(env, "codex", config)).toEqual({ PATH: "/bin" });
  });

  it("不修改原环境，跳过 undefined 值", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "x", EMPTY: undefined, KEEP: "1" };
    expect(buildChildEnv(env, "codex", undefined)).toEqual({ KEEP: "1" });
    expect(env["OPENAI_API_KEY"]).toBe("x");
  });
});
