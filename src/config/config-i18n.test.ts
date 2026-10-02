/**
 * 配置说明与诊断的界面语言（docs/wave6-plan.md §5.5、D21）。[W6-I4]
 *
 * 测试缺省钉 zh（test/helpers/setup.ts）；这里切 en 的用例在 afterEach 改回 zh。
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { messagesFor, setLocale } from "../i18n/index.js";
import { CONFIG_SCHEMA_FILE, buildConfigJsonSchema, configSchemaText } from "./json-schema.js";
import { describeInit, initConfigDir, initNextSteps } from "./init.js";
import {
  CONFIG_KEY_DOCS,
  DYNAMIC_DEFAULTS,
  configKeyDocs,
  documentedLeaves,
  dynamicDefaults,
  isDynamicDefault,
  keyDoc,
} from "./key-docs.js";
import { parseJsonText } from "./load.js";
import { settingDefault, settingDoc, settingDynamicDefault } from "./settings-registry.js";
import { validateConfig } from "./schema.js";

const CJK = /[㐀-鿿豈-﫿]/;

/** 去掉全部 description，比较结构。 */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "description") out[key] = strip(child);
  }
  return out;
}

afterEach(() => setLocale("zh"));

describe("keyDoc(path)", () => {
  it("按界面语言取说明；未知键返回 undefined", () => {
    expect(keyDoc("permission.mode")).toBe("权限模式；项目级只能更严");
    setLocale("en");
    expect(keyDoc("permission.mode")).toBe(
      "Permission mode; project level can only make it stricter",
    );
    expect(keyDoc("no.such.key")).toBeUndefined();
    expect(keyDoc("toString")).toBeUndefined();
  });

  it("两种语言的键集合相同；en 无汉字；兼容导出是中文原表", () => {
    const zh = messagesFor("zh").config;
    const en = messagesFor("en").config;
    expect(Object.keys(en.keys).sort()).toEqual(Object.keys(zh.keys).sort());
    expect(Object.keys(en.dynamicDefaults).sort()).toEqual(Object.keys(zh.dynamicDefaults).sort());
    for (const [path, text] of Object.entries(en.keys)) expect(CJK.test(text), path).toBe(false);
    for (const [path, text] of Object.entries(en.dynamicDefaults))
      expect(CJK.test(text), path).toBe(false);
    expect(CONFIG_KEY_DOCS).toEqual(zh.keys);
    expect(DYNAMIC_DEFAULTS).toEqual(zh.dynamicDefaults);
    expect(configKeyDocs()).toBe(zh.keys);
    setLocale("en");
    expect(configKeyDocs()).toBe(en.keys);
    expect(dynamicDefaults()).toBe(en.dynamicDefaults);
  });

  it("isDynamicDefault 与语言无关；叶子集合与语言无关", () => {
    const zhLeaves = documentedLeaves();
    expect(isDynamicDefault("defaultModel")).toBe(true);
    expect(isDynamicDefault("permission.mode")).toBe(false);
    setLocale("en");
    expect(isDynamicDefault("defaultModel")).toBe(true);
    expect(documentedLeaves()).toEqual(zhLeaves);
  });
});

describe("/config 面板的键说明（settings-registry）", () => {
  it("settingDoc / settingDynamicDefault 按界面语言；settingDefault 与语言无关", () => {
    expect(settingDoc("ui.theme")).toBe(keyDoc("ui.theme"));
    expect(settingDynamicDefault("defaultModel")).toBe("零配置自动选择");
    const zhDefault = settingDefault("tools.preset");
    setLocale("en");
    expect(settingDoc("ui.theme")).toMatch(/^Color theme: dark, light, or auto/);
    expect(settingDynamicDefault("defaultModel")).toBe(
      "picked automatically with zero configuration",
    );
    expect(settingDynamicDefault("toString")).toBeUndefined();
    expect(settingDefault("tools.preset")).toEqual(zhDefault);
    expect(settingDefault("defaultModel")).toBeUndefined();
  });
});

describe("config.schema.json 跟随界面语言（D21）", () => {
  it("en 版无汉字，与 zh 版只差 description", () => {
    const zh = buildConfigJsonSchema();
    setLocale("en");
    const en = buildConfigJsonSchema();
    expect(CJK.test(JSON.stringify(en))).toBe(false);
    expect(strip(en)).toEqual(strip(zh));
    const props = en["properties"] as Record<string, Record<string, unknown>>;
    expect(props["defaultModel"]?.["description"]).toBe(keyDoc("defaultModel"));
    const provider = (props["providers"]?.["additionalProperties"] ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const channels = (provider["properties"] as Record<string, Record<string, unknown>>)[
      "channels"
    ];
    expect(channels?.["description"]).toBe("Channels: several endpoints under one provider");
  });

  it("ama init 按当前语言重写 schema：切语言时 updated，同语言再跑 unchanged", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ama-init-lang-")), "ama");
    initConfigDir(dir);
    const zhText = readFileSync(join(dir, CONFIG_SCHEMA_FILE), "utf8");
    expect(CJK.test(zhText)).toBe(true);
    setLocale("en");
    const switched = initConfigDir(dir);
    expect(switched.files[1]?.status).toBe("updated");
    const enText = readFileSync(join(dir, CONFIG_SCHEMA_FILE), "utf8");
    expect(enText).toBe(configSchemaText());
    expect(CJK.test(enText)).toBe(false);
    expect(initConfigDir(dir).files[1]?.status).toBe("unchanged");
    expect(describeInit(switched)).toContain("updated to the current version");
    expect(describeInit(switched)).toContain("already exists, left unchanged");
  });
});

describe("配置诊断与 init 文案的 en 版", () => {
  it("诊断按界面语言；zh 原文不变", () => {
    const bad = { version: 2, ui: { theme: "pink" }, retry: { maxRetries: 1000 } };
    expect(validateConfig(bad).map((d) => d.message)).toEqual([
      "version 必须为 1",
      "应在 0–100 之间",
      "取值应为 dark | light | auto",
    ]);
    setLocale("en");
    expect(validateConfig(bad).map((d) => d.message)).toEqual([
      "version must be 1",
      "should be between 0 and 100",
      "should be one of dark | light | auto",
    ]);
    expect(() => parseJsonText("")).toThrow("JSON syntax error: the file is empty");
  });

  it("下一步提示：initNextSteps 按语言，中文原文不变", () => {
    const zh = initNextSteps();
    expect(zh[0]).toBe("下一步：");
    expect(zh[4]).toBe("  ama config show                 查看生效配置与每项来源");
    setLocale("en");
    const steps = initNextSteps();
    expect(steps[0]).toBe("Next steps:");
    expect(steps).toHaveLength(zh.length);
    for (const line of steps) expect(CJK.test(line)).toBe(false);
  });
});
