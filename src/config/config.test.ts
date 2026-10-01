import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTmpHome, withTmpHome } from "../../test/helpers/tmp-home.js";
import { StartupError } from "../errors.js";
import {
  describeAuthFile,
  readAuthFile,
  removeAuthKey,
  setAuthKey,
  classifyKeyValue,
} from "./auth-file.js";
import { findContextFiles } from "./context-files.js";
import { lineColumnAt, loadConfigFile, parseJsonText } from "./load.js";
import {
  DEFAULT_CONFIG,
  mergeBaseLayers,
  mergeConfigLayers,
  mergeProjectAndCli,
  restrictProjectConfig,
} from "./merge.js";
import { resolveConfigDir, resolveDataDir, resolvePaths, ensurePaths } from "./paths.js";
import { loadProfile } from "./profile.js";
import { validateConfig, validateHookConfig } from "./schema.js";
import {
  decideTrust,
  findTrustEntry,
  readTrustFile,
  recordTrust,
  trustGatedResources,
} from "./trust.js";
import type { AmaConfig } from "./types.js";

const posix = process.platform !== "win32";

function startupCode(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof StartupError) return error.exitCode;
    throw error;
  }
  return undefined;
}

describe("paths", () => {
  it("AMA_CONFIG_DIR / XDG / APPDATA / 缺省", () => {
    expect(resolveConfigDir({ env: { AMA_CONFIG_DIR: "/x/cfg" }, platform: "linux" })).toBe(
      resolve("/x/cfg"),
    );
    expect(
      resolveConfigDir({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", home: "/h" }),
    ).toBe(join("/xdg", "ama"));
    expect(resolveConfigDir({ env: {}, platform: "linux", home: "/h" })).toBe(
      join("/h", ".config", "ama"),
    );
    expect(resolveConfigDir({ env: { APPDATA: "C:\\R" }, platform: "win32", home: "/h" })).toBe(
      join("C:\\R", "ama"),
    );
    expect(resolveDataDir({ env: {}, platform: "linux", home: "/h" })).toBe(
      join("/h", ".local", "share", "ama"),
    );
  });

  it("sessionDir：--session-dir > profile > dataDir/sessions；建目录 0700", async () => {
    await withTmpHome((home) => {
      const env = home.env;
      const def = resolvePaths({ env, cwd: home.cwd });
      expect(def.sessionDir).toBe(join(home.dataDir, "sessions"));
      expect(resolvePaths({ env, cwd: home.cwd, profileSessionDir: "/p/s" }).sessionDir).toBe(
        resolve("/p/s"),
      );
      expect(
        resolvePaths({ env, cwd: home.cwd, sessionDirFlag: "s", profileSessionDir: "/p/s" })
          .sessionDir,
      ).toBe(join(home.cwd, "s"));
      ensurePaths(def);
      if (posix) expect(statSync(def.sessionDir).mode & 0o777).toBe(0o700);
    });
  });

  it("目录不可写 → 退出码 3", async () => {
    await withTmpHome((home) => {
      const file = home.write("blocker", "x");
      const paths = resolvePaths({
        env: home.env,
        cwd: home.cwd,
        sessionDirFlag: join(file, "sub"),
      });
      expect(startupCode(() => ensurePaths(paths))).toBe(3);
    });
  });
});

describe("schema / load", () => {
  it("JSON 语法错误给出行列号", () => {
    expect(lineColumnAt("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
    expect(() => parseJsonText('{\n  "version": 1,\n  oops\n}')).toThrow(/第 3 行/);
  });

  it("字段错误给出字段路径，未知字段只警告", async () => {
    await withTmpHome((home) => {
      const bad = home.write("bad.json", { version: 1, permission: { mode: "yolo" } });
      try {
        loadConfigFile("config", bad);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(StartupError);
        expect((error as StartupError).exitCode).toBe(3);
        expect((error as Error).message).toContain("permission.mode");
      }
      const ok = home.write("ok.json", { version: 1, extra: true });
      expect(loadConfigFile("config", ok)?.warnings[0]).toContain("extra");
      expect(loadConfigFile("config", home.path("missing.json"))).toBeUndefined();
    });
  });

  it("hooks.json 校验：未知事件、type、超时上限", () => {
    const diags = validateHookConfig({
      version: 1,
      hooks: {
        Nope: [],
        PreToolUse: [{ hooks: [{ type: "shell", command: "x", timeoutMs: 700_000 }] }],
      },
    });
    const paths = diags.filter((d) => d.severity === "error").map((d) => d.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "hooks.Nope",
        "hooks.PreToolUse[0].hooks[0].type",
        "hooks.PreToolUse[0].hooks[0].timeoutMs",
      ]),
    );
    expect(validateConfig({ version: 2 }).some((d) => d.path === "version")).toBe(true);
  });
});

describe("merge：缺省 ← 用户级 ← profile ← 项目级（收紧）← 命令行", () => {
  const user: AmaConfig = {
    version: 1,
    defaultModel: "anthropic/x",
    permission: { mode: "auto-edit", allow: ["bash(git status*)"], deny: ["write(**/.env*)"] },
    tools: { disabled: ["todo"] },
  };

  it("深合并与累加列表", () => {
    const profile: AmaConfig = {
      version: 1,
      permission: { allow: ["canvas_*"] },
      ui: { theme: "light" },
    };
    const result = mergeConfigLayers({ user, profile, hasProfile: true });
    expect(result.config.defaultModel).toBe("anthropic/x");
    expect(result.config.permission?.allow).toEqual(["bash(git status*)", "canvas_*"]);
    expect(result.config.ui?.theme).toBe("light");
    // 有 profile 时启动画面缺省 header（§12.10）
    expect(result.config.ui?.quietStartup).toBe("header");
    expect(result.config.compaction).toEqual(DEFAULT_CONFIG.compaction);
    expect(result.ruleSpecs.map((r) => `${r.source}:${r.effect}:${r.raw}`)).toEqual([
      "user:allow:bash(git status*)",
      "user:deny:write(**/.env*)",
      "profile:allow:canvas_*",
    ]);
  });

  it("项目级只能收紧：allow 与放宽 mode 被忽略并 warning", () => {
    const project: AmaConfig = {
      version: 1,
      defaultModel: "evil/model",
      permission: { mode: "full-auto", allow: ["bash(*)"], deny: ["bash(rm *)"] },
      tools: { disabled: ["bash"], bashTimeoutMs: 1 },
      ui: { theme: "light" },
    };
    const result = mergeConfigLayers({ user, project });
    expect(result.config.permission?.mode).toBe("auto-edit");
    expect(result.config.permission?.allow).toEqual(["bash(git status*)"]);
    expect(result.config.permission?.deny).toEqual(["write(**/.env*)", "bash(rm *)"]);
    expect(result.config.defaultModel).toBe("anthropic/x");
    expect(result.config.tools?.disabled).toEqual(["todo", "bash"]);
    expect(result.config.tools?.bashTimeoutMs).toBe(120_000);
    expect(result.config.ui?.theme).toBe("light");
    expect(result.warnings.join("\n")).toMatch(/allow/);
    expect(result.warnings.join("\n")).toMatch(/full-auto/);
    expect(result.warnings.join("\n")).toMatch(/defaultModel/);
    expect(result.warnings.join("\n")).toMatch(/bashTimeoutMs/);
  });

  it("项目级收紧 mode 生效；命令行最后叠加", () => {
    const project: AmaConfig = { version: 1, permission: { mode: "plan" } };
    expect(mergeConfigLayers({ user, project }).config.permission?.mode).toBe("plan");
    const base = mergeBaseLayers({ user });
    const withCli = mergeProjectAndCli(base, project, { permissionMode: "default", deny: ["x"] });
    expect(withCli.config.permission?.mode).toBe("default");
    expect(withCli.ruleSpecs.at(-1)).toEqual({ effect: "deny", raw: "x", source: "cli" });
    expect(
      restrictProjectConfig({ version: 1, permission: { mode: "default" } }, "default").warnings,
    ).toEqual([]);
  });

  it("临时 HOME 下从文件读出层级", async () => {
    await withTmpHome((home) => {
      home.write("home/.config/ama/config.json", user);
      home.write("work/.ama/config.json", { version: 1, permission: { allow: ["read(**)"] } });
      const u = loadConfigFile("config", join(home.configDir, "config.json"));
      const p = loadConfigFile("config", join(home.cwd, ".ama", "config.json"));
      const merged = mergeConfigLayers({ user: u?.value, project: p?.value });
      expect(merged.config.permission?.allow).toEqual(["bash(git status*)"]);
      expect(merged.layers).toEqual(["default", "user", "project"]);
    });
  });
});

describe("profile", () => {
  it("展开字段；不存在 / 版本不符 / 相对路径 → 3", async () => {
    await withTmpHome((home) => {
      const cfg = home.write("p/config.json", { version: 1, ui: { theme: "light" } });
      const good = home.write("p/profile.json", {
        version: 1,
        host: "/abs/host.cjs",
        instructions: ["/abs/i.md"],
        config: cfg,
        trustProject: true,
        authEnv: false,
      });
      const profile = loadProfile(good);
      expect(profile.host).toBe("/abs/host.cjs");
      expect(profile.config?.ui?.theme).toBe("light");
      expect(profile.trustProject).toBe(true);
      expect(profile.authEnv).toBe(false);
      expect(startupCode(() => loadProfile(home.path("p/none.json")))).toBe(3);
      const v2 = home.write("p/v2.json", { version: 2 });
      expect(startupCode(() => loadProfile(v2))).toBe(3);
      const rel = home.write("p/rel.json", { version: 1, hooksFile: "hooks.json" });
      expect(startupCode(() => loadProfile(rel))).toBe(3);
    });
  });
});

describe("trust", () => {
  it("决策顺序：flag → profile → trust.json 最近祖先 → 询问 → 不信任", async () => {
    await withTmpHome(async (home) => {
      const deep = join(home.cwd, "a", "b");
      mkdirSync(deep, { recursive: true });
      const base = { cwd: deep, configDir: home.configDir, interactive: false };
      expect(await decideTrust({ ...base, flag: false, profileTrust: true })).toEqual({
        trusted: false,
        source: "flag",
      });
      expect((await decideTrust({ ...base, profileTrust: true })).source).toBe("profile");
      expect(await decideTrust(base)).toEqual({ trusted: false, source: "default" });
      recordTrust(home.configDir, home.cwd, true);
      recordTrust(home.configDir, join(home.cwd, "a"), false);
      const fromFile = await decideTrust(base);
      expect(fromFile).toMatchObject({ trusted: false, source: "trust-file" });
      expect(fromFile.matchedPath).toBe(join(home.cwd, "a"));
      expect(findTrustEntry(readTrustFile(home.configDir).entries, home.cwd)?.trusted).toBe(true);
      expect(findTrustEntry(readTrustFile(home.configDir).entries, home.root)).toBeUndefined();
    });
  });

  it("交互询问只在有需信任资源时发生，记住则写 trust.json", async () => {
    await withTmpHome(async (home) => {
      let asked = 0;
      const prompt = async () => {
        asked++;
        return { trusted: true, remember: true };
      };
      const input = { cwd: home.cwd, configDir: home.configDir, interactive: true, prompt };
      expect((await decideTrust(input)).source).toBe("default");
      expect(asked).toBe(0);
      home.write("work/.ama/hooks.json", { version: 1, hooks: {} });
      expect(trustGatedResources(home.cwd)).toHaveLength(1);
      expect(await decideTrust(input)).toEqual({ trusted: true, source: "prompt" });
      expect(asked).toBe(1);
      expect((await decideTrust(input)).source).toBe("trust-file");
      expect(asked).toBe(1);
    });
  });
});

describe("auth.json", () => {
  it("set / remove 以 0600 写入，list 不暴露 key", async () => {
    await withTmpHome((home) => {
      const path = join(home.configDir, "auth.json");
      setAuthKey(path, "anthropic", "sk-secret");
      setAuthKey(path, "deepseek", "!pass show ds");
      if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
      const read = readAuthFile(path);
      expect(read.file.providers["anthropic"]?.apiKey).toBe("sk-secret");
      const summary = describeAuthFile(read.file);
      expect(summary.map((s) => `${s.provider}:${s.kind}`)).toEqual([
        "anthropic:literal",
        "deepseek:command",
      ]);
      expect(JSON.stringify(summary)).not.toContain("sk-secret");
      expect(removeAuthKey(path, "anthropic")).toBe(true);
      expect(removeAuthKey(path, "anthropic")).toBe(false);
      expect(classifyKeyValue("${X_KEY}")).toBe("env-ref");
    });
  });

  it.skipIf(!posix)("权限不是 0600 → warning 照用", async () => {
    await withTmpHome((home) => {
      const path = home.write(
        "home/.config/ama/auth.json",
        { version: 1, providers: { a: { apiKey: "k" } } },
        0o644,
      );
      const read = readAuthFile(path);
      expect(read.file.providers["a"]?.apiKey).toBe("k");
      expect(read.warnings.join()).toMatch(/0600/);
    });
  });
});

describe("AGENTS.md 向上查找", () => {
  it("用户级在前、外层在前；override 优先；内容相同去重", () => {
    const home = createTmpHome();
    try {
      const deep = join(home.cwd, "pkg", "sub");
      mkdirSync(deep, { recursive: true });
      home.write("home/.config/ama/AGENTS.md", "global");
      home.write("AGENTS.md", "root");
      home.write("work/AGENTS.md", "work");
      home.write("work/pkg/AGENTS.md", "pkg");
      home.write("work/pkg/AGENTS.override.md", "pkg-override");
      home.write("work/pkg/sub/AGENTS.md", "work");
      const { files } = findContextFiles({ cwd: deep, configDir: home.configDir });
      const contents = files.map((f) => f.content);
      expect(contents.slice(0, 1)).toEqual(["global"]);
      const idx = (c: string) => contents.indexOf(c);
      expect(idx("root")).toBeLessThan(idx("work"));
      expect(idx("work")).toBeLessThan(idx("pkg-override"));
      expect(contents).not.toContain("pkg");
      // sub 的内容与 work 相同（worktree 场景）→ 只出现一次
      expect(contents.filter((c) => c === "work")).toHaveLength(1);
      expect(files[0]?.scope).toBe("user");
    } finally {
      home.cleanup();
    }
  });

  it.skipIf(!posix)("符号链接指向同一文件只取一次", () => {
    const home = createTmpHome();
    try {
      const target = home.write("work/AGENTS.md", "same");
      const sub = join(home.cwd, "sub");
      mkdirSync(sub);
      symlinkSync(target, join(sub, "AGENTS.override.md"));
      writeFileSync(join(sub, "AGENTS.md"), "ignored");
      const { files } = findContextFiles({ cwd: sub });
      expect(files.filter((f) => f.content === "same")).toHaveLength(1);
      expect(files.map((f) => f.content)).not.toContain("ignored");
    } finally {
      home.cleanup();
    }
  });
});
