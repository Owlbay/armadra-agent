import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import {
  ConfigEditError,
  getConfigValue,
  overriddenFor,
  parseValue,
  readSnapshot,
  setConfigValue,
  unsetConfigValue,
  type ConfigLayerInput,
} from "./edit.js";

let home: TmpHome;
beforeEach(() => {
  home = createTmpHome();
});
afterEach(() => home.cleanup());

const input = (extra: Partial<ConfigLayerInput> = {}): ConfigLayerInput => ({
  configDir: home.configDir,
  cwd: home.cwd,
  env: {},
  ...extra,
});
const userPath = (): string => join(home.configDir, "config.json");
const projectPath = (): string => join(home.cwd, ".ama", "config.json");

const USER_TEXT = `{
  "$schema": "./config.schema.json",
  "version": 1,
  "providers": {
    "proxy": { "baseUrl": "https://x", "apiKey": "$PROXY_KEY" }
  },
  "ui": { "theme": "dark" },
  "thinkingLevel": "high"
}
`;

function expectRefused(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigEditError);
  expect((caught as ConfigEditError).code).toBe(code);
  expect((caught as ConfigEditError).exitCode).toBe(3);
}

describe("setConfigValue (user)", () => {
  it("changes one path, keeps other fields and key order, 2-space + newline, .bak, mode", () => {
    writeFileSync(userPath(), USER_TEXT, { mode: 0o600 });
    const result = setConfigValue({ ...input(), scope: "user", key: "ui.theme", value: "light" });
    const text = readFileSync(userPath(), "utf8");
    expect(text).toBe(
      `${JSON.stringify(
        {
          $schema: "./config.schema.json",
          version: 1,
          providers: { proxy: { baseUrl: "https://x", apiKey: "$PROXY_KEY" } },
          ui: { theme: "light" },
          thinkingLevel: "high",
        },
        null,
        2,
      )}\n`,
    );
    expect(readFileSync(`${userPath()}.bak`, "utf8")).toBe(USER_TEXT);
    if (process.platform !== "win32") expect(statSync(userPath()).mode & 0o777).toBe(0o600);
    expect(result.before).toMatchObject({ value: "dark", source: "user" });
    expect(result.after).toMatchObject({ value: "light", source: "user" });
    expect(result.apply).toBe("restart");
    expect(result.prefixChanged).toBe(false);
  });

  it("re-reads the file before writing (external edits survive)", () => {
    writeFileSync(userPath(), USER_TEXT);
    setConfigValue({ ...input(), scope: "user", key: "ui.markdown", value: false });
    const external = JSON.parse(readFileSync(userPath(), "utf8")) as Record<string, unknown>;
    external["fallbackModel"] = "openai/gpt-x";
    writeFileSync(userPath(), JSON.stringify(external, null, 2));
    setConfigValue({ ...input(), scope: "user", key: "ui.compact", value: true });
    const final = JSON.parse(readFileSync(userPath(), "utf8")) as Record<string, unknown>;
    expect(final["fallbackModel"]).toBe("openai/gpt-x");
    expect(final["ui"]).toEqual({ theme: "dark", markdown: false, compact: true });
  });

  it("creates a minimal file when missing; unset clears empty sections", () => {
    setConfigValue({ ...input(), scope: "user", key: "retry.maxRetries", value: 5 });
    expect(JSON.parse(readFileSync(userPath(), "utf8"))).toEqual({
      $schema: "./config.schema.json",
      version: 1,
      providers: {},
      retry: { maxRetries: 5 },
    });
    const result = unsetConfigValue({ ...input(), scope: "user", key: "retry.maxRetries" });
    expect(JSON.parse(readFileSync(userPath(), "utf8"))).toEqual({
      $schema: "./config.schema.json",
      version: 1,
      providers: {},
    });
    expect(result.after).toMatchObject({ value: 3, source: "default" });
  });

  it("invalid values leave the file byte-for-byte unchanged", () => {
    writeFileSync(userPath(), USER_TEXT);
    expectRefused(
      () => setConfigValue({ ...input(), scope: "user", key: "ui.theme", value: "neon" }),
      "config_invalid_value",
    );
    expectRefused(
      () => setConfigValue({ ...input(), scope: "user", key: "retry.maxRetries", value: -1 }),
      "config_invalid_value",
    );
    expectRefused(
      () => setConfigValue({ ...input(), scope: "user", key: "nope.key", value: 1 }),
      "config_unknown_key",
    );
    expect(readFileSync(userPath(), "utf8")).toBe(USER_TEXT);
    expect(existsSync(`${userPath()}.bak`)).toBe(false);
  });

  it("marks prefix changes", () => {
    const result = setConfigValue({
      ...input(),
      scope: "user",
      key: "thinkingLevel",
      value: "low",
    });
    expect(result.prefixChanged).toBe(true);
    expect(result.apply).toBe("now");
  });
});

describe("setConfigValue (project)", () => {
  it("refuses loosening and user-only keys without touching the file", () => {
    expectRefused(
      () =>
        setConfigValue({
          ...input(),
          scope: "project",
          key: "permission.mode",
          value: "full-auto",
        }),
      "config_project_denied",
    );
    expect(existsSync(projectPath())).toBe(false);
    home.write("work/.ama/config.json", `{ "version": 1, "ui": { "theme": "light" } }\n`);
    const before = readFileSync(projectPath(), "utf8");
    expectRefused(
      () => setConfigValue({ ...input(), scope: "project", key: "cache.warming", value: "idle" }),
      "config_project_denied",
    );
    expectRefused(
      () =>
        setConfigValue({
          ...input(),
          scope: "project",
          key: "tools.preset",
          value: "codemode-only",
        }),
      "config_project_denied",
    );
    expectRefused(
      () =>
        setConfigValue({ ...input(), scope: "project", key: "ui.replyLanguage", value: "Chinese" }),
      "config_project_denied",
    );
    expect(readFileSync(projectPath(), "utf8")).toBe(before);
  });

  it("accepts tightening (measured against user level)", () => {
    home.write("home/.config/ama/config.json", { version: 1, permission: { mode: "auto-edit" } });
    const result = setConfigValue({
      ...input(),
      scope: "project",
      key: "permission.mode",
      value: "default",
    });
    expect(result.after).toMatchObject({ value: "default", source: "project" });
    expect(JSON.parse(readFileSync(projectPath(), "utf8"))).toEqual({
      version: 1,
      permission: { mode: "default" },
    });
    setConfigValue({ ...input(), scope: "project", key: "ui.theme", value: "light" });
    expect(readSnapshot(input()).config.ui?.theme).toBe("light");
  });
});

describe("getConfigValue", () => {
  it("reports default / user / project / profile / cli / env sources", () => {
    home.write("home/.config/ama/config.json", {
      version: 1,
      ui: { markdown: false },
      permission: { mode: "auto-edit" },
    });
    home.write("work/.ama/config.json", { version: 1, permission: { mode: "plan" } });
    const snapshot = readSnapshot(
      input({
        env: { AMA_CACHE_WARMING: "off" },
        hasProfile: true,
        profile: { config: { version: 1, ui: { theme: "light" } } },
        cli: { thinkingLevel: "xhigh" },
      }),
    );
    expect(getConfigValue(snapshot, "ui.markdown")).toMatchObject({ value: false, source: "user" });
    expect(getConfigValue(snapshot, "ui.theme")).toMatchObject({
      value: "light",
      source: "profile",
    });
    expect(getConfigValue(snapshot, "ui.statusLine")).toMatchObject({
      value: "compact",
      source: "profile",
    });
    const mode = getConfigValue(snapshot, "permission.mode");
    expect(mode).toMatchObject({ value: "plan", source: "project" });
    expect(overriddenFor(mode, "user")).toBe("project");
    expect(overriddenFor(mode, "project")).toBeUndefined();
    expect(getConfigValue(snapshot, "thinkingLevel")).toMatchObject({
      value: "xhigh",
      source: "cli",
    });
    expect(getConfigValue(snapshot, "cache.warming")).toMatchObject({
      value: "off",
      source: "env",
      envName: "AMA_CACHE_WARMING",
    });
    expect(getConfigValue(snapshot, "retry.maxRetries")).toMatchObject({
      value: 3,
      source: "default",
    });
    expect(getConfigValue(snapshot, "fallbackModel")).toMatchObject({
      value: undefined,
      source: "default",
    });
  });

  it("ignores a project value that the merge would drop", () => {
    home.write("work/.ama/config.json", { version: 1, permission: { mode: "full-auto" } });
    const value = getConfigValue(readSnapshot(input()), "permission.mode");
    expect(value).toMatchObject({ value: "default", source: "default" });
  });
});

describe("parseValue", () => {
  it("parses by kind", () => {
    expect(parseValue("ui.markdown", "off")).toBe(false);
    expect(parseValue("ui.markdown", "1")).toBe(true);
    expect(parseValue("ui.theme", "LIGHT")).toBe("light");
    expect(parseValue("permission.mode", "default")).toBe("default");
    expect(parseValue("ui.theme", "default")).toBeUndefined();
    expect(parseValue("ui.theme", "none")).toBeUndefined();
    expect(parseValue("tools.preset", "codemode")).toBe("codemode");
    expect(parseValue("tools.maxToolResultChars", "30_000")).toBe(30000);
    expect(parseValue("compaction.prune.clearAtLeast", "AUTO")).toBe("auto");
    expect(parseValue("compaction.prune.clearAtLeast", "40000")).toBe(40000);
    expect(parseValue("limits.maxTurns", "unlimited")).toBeUndefined();
    expect(parseValue("defaultModel", "anthropic/claude-x@main")).toBe("anthropic/claude-x@main");
    expect(parseValue("ui.replyLanguage", " Chinese ")).toBe("Chinese");
    expect(parseValue("tools.disabled", '["bash"]', true)).toEqual(["bash"]);
    expect(parseValue("auth.chatgpt.issuer", "https://x")).toBe("https://x");
  });

  it("rejects bad input", () => {
    expectRefused(() => parseValue("ui.markdown", "maybe"), "config_invalid_value");
    expectRefused(() => parseValue("ui.theme", "neon"), "config_invalid_value");
    expectRefused(() => parseValue("retry.maxRetries", "lots"), "config_invalid_value");
    expectRefused(() => parseValue("retry.maxRetries", "101"), "config_invalid_value");
    expectRefused(() => parseValue("defaultModel", "claude"), "config_invalid_value");
    expectRefused(() => parseValue("tools.disabled", "bash"), "config_invalid_value");
    expectRefused(() => parseValue("tools.disabled", "[bash", true), "config_invalid_value");
    expectRefused(() => parseValue("no.such", "1"), "config_unknown_key");
  });
});
