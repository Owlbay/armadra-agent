/**
 * 第六波配置键（docs/wave6-plan.md §7；[W6-C0]）：形状校验、项目级限制、profile / 命令行、auth.json 联合类型。
 */

import { describe, expect, it } from "vitest";
import { describeAuthFile } from "./auth-file.js";
import { mergeBaseLayers, mergeConfigLayers, restrictProjectConfig } from "./merge.js";
import { validateAuthFile, validateConfig, validateProfile } from "./schema.js";
import { apiKeyEntry, isOAuthEntry, type AmaConfig, type AuthFile } from "./types.js";

const errors = (diagnostics: { severity: string; path: string }[]) =>
  diagnostics.filter((d) => d.severity === "error").map((d) => d.path);

describe("形状", () => {
  it("ui.language / replyLanguage / agentBar、memory、auth.chatgpt 合法时无诊断", () => {
    expect(
      validateConfig({
        version: 1,
        ui: { language: "zh", replyLanguage: "Chinese", agentBar: "off" },
        memory: {
          enabled: true,
          scopes: ["user"],
          indexMaxBytes: 4096,
          fileMaxBytes: 16384,
          maxFiles: 200,
          subagents: "off",
        },
        auth: {
          chatgpt: {
            flavor: "codex",
            clientId: "x",
            issuer: "https://auth.example",
            originator: "o",
            redirectPorts: [1455, 0],
          },
        },
      }),
    ).toEqual([]);
  });

  it("取值错误是 error，未知字段是 warning", () => {
    const diagnostics = validateConfig({
      version: 1,
      ui: { agentBar: "on", replyLanguage: 1 },
      memory: { enabled: "yes", scopes: ["team"], maxFiles: 0, subagents: "write", extra: 1 },
      auth: { chatgpt: { flavor: "claude", redirectPorts: [70000] }, google: {} },
    });
    expect(errors(diagnostics).sort()).toEqual(
      [
        "auth.chatgpt.flavor",
        "auth.chatgpt.redirectPorts",
        "memory.enabled",
        "memory.maxFiles",
        "memory.scopes",
        "memory.subagents",
        "ui.agentBar",
        "ui.replyLanguage",
      ].sort(),
    );
    expect(diagnostics.filter((d) => d.severity === "warning").map((d) => d.path)).toEqual([
      "memory.extra",
      "auth.google",
    ]);
    expect(diagnostics.find((d) => d.path === "memory.scopes")?.message).toBe(
      "应为 user | project 组成的数组",
    );
  });
});

describe("项目级（只能收紧）", () => {
  const restrict = (project: Partial<AmaConfig>) =>
    restrictProjectConfig({ version: 1, ...project } as AmaConfig, "default", "p");

  it("ui.language / agentBar 照收；replyLanguage 忽略并 warning", () => {
    const r = restrict({ ui: { language: "en", agentBar: "off", replyLanguage: "French" } });
    expect(r.accepted.ui).toEqual({ language: "en", agentBar: "off" });
    expect(r.warnings).toEqual(["p: 项目级不能设 ui.replyLanguage，已忽略"]);
  });

  it("memory 只接受 enabled: false；打开或其它键忽略并 warning", () => {
    expect(restrict({ memory: { enabled: false } })).toEqual({
      accepted: { memory: { enabled: false } },
      warnings: [],
    });
    const on = restrict({ memory: { enabled: true, maxFiles: 5 } });
    expect(on.accepted.memory).toBeUndefined();
    expect(on.warnings).toEqual([
      "p: 项目级只能把 memory.enabled 设为 false，忽略 memory 的其它键",
    ]);
  });

  it("auth 整段只认用户级", () => {
    const r = restrict({ auth: { chatgpt: { flavor: "codex" } } });
    expect(r.accepted.auth).toBeUndefined();
    expect(r.warnings).toEqual(["p: 项目级不能设 auth，已忽略"]);
  });
});

describe("层级", () => {
  it("Agent 栏缺省都不设（auto）：嵌入宿主（有 profile）不再强制 off [W7-A]", () => {
    expect(mergeBaseLayers({ hasProfile: true }).config.ui?.agentBar).toBeUndefined();
    expect(mergeBaseLayers({}).config.ui?.agentBar).toBeUndefined();
    // 宿主要关就在自己的 profile 写；其余 profile 缺省照旧
    const off = mergeBaseLayers({
      hasProfile: true,
      profile: { version: 1, ui: { agentBar: "off" } },
    });
    expect(off.config.ui).toMatchObject({ agentBar: "off", statusLine: "compact" });
  });

  it("--memory / --no-memory 覆盖 memory.enabled（命令行最后叠加）", () => {
    const user: AmaConfig = { version: 1, memory: { enabled: true, maxFiles: 9 } };
    expect(mergeConfigLayers({ user, cli: { memory: false } }).config.memory).toEqual({
      enabled: false,
      maxFiles: 9,
    });
    expect(mergeConfigLayers({ cli: { memory: true } }).config.memory).toEqual({ enabled: true });
  });
});

describe("profile.memory（D11）", () => {
  it("enabled: true 必须给绝对路径 dir；关闭时可以不给", () => {
    expect(validateProfile({ version: 1, memory: { enabled: false } })).toEqual([]);
    expect(validateProfile({ version: 1, memory: { enabled: true, dir: "/ws/mem" } })).toEqual([]);
    expect(errors(validateProfile({ version: 1, memory: { enabled: true } }))).toEqual([
      "memory.dir",
    ]);
    expect(errors(validateProfile({ version: 1, memory: { enabled: true, dir: "mem" } }))).toEqual([
      "memory.dir",
    ]);
    expect(errors(validateProfile({ version: 1, memory: {} }))).toEqual(["memory.enabled"]);
  });
});

describe("auth.json 联合类型", () => {
  const file: AuthFile = {
    version: 1,
    providers: {
      anthropic: { apiKey: "$ANTHROPIC_API_KEY" },
      chatgpt: {
        type: "oauth",
        flavor: "siwc",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1,
      },
    },
  };

  it("OAuth 条目通过校验；缺必填字段报错", () => {
    expect(validateAuthFile(file)).toEqual([]);
    expect(
      errors(
        validateAuthFile({
          version: 1,
          providers: { chatgpt: { type: "oauth", accessToken: "a" } },
        }),
      ).sort(),
    ).toEqual([
      "providers.chatgpt.expiresAt",
      "providers.chatgpt.flavor",
      "providers.chatgpt.refreshToken",
    ]);
  });

  it("区分条目；describeAuthFile 对 OAuth 只给 kind / flavor / expiresIn / needsLogin，不碰 token", () => {
    expect(isOAuthEntry(file.providers["chatgpt"])).toBe(true);
    expect(apiKeyEntry(file.providers["chatgpt"])).toBeUndefined();
    expect(apiKeyEntry(file.providers["anthropic"])?.apiKey).toBe("$ANTHROPIC_API_KEY");
    // [W6-O] OAuth 条目补 flavor / expiresIn / needsLogin（C0 时只有 kind）
    const described = describeAuthFile(file, 1001);
    expect(described).toEqual([
      { provider: "anthropic", kind: "env-ref", hasBaseUrl: false, envNames: [] },
      {
        provider: "chatgpt",
        kind: "oauth",
        hasBaseUrl: false,
        envNames: [],
        flavor: "siwc",
        expiresIn: -1000,
        needsLogin: false,
      },
    ]);
    expect(JSON.stringify(described)).not.toContain("rt");
  });
});
