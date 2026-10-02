/**
 * i18n 核心（docs/wave6-plan.md §5.1、§5.2）。[W6-C0]
 */

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  formatDuration,
  getLocale,
  messagesFor,
  msg,
  parseLocale,
  plural,
  resolveLocale,
  resolveLocaleWithSource,
  setLocale,
  MESSAGE_DOMAINS,
  type Messages,
} from "./index.js";
import { CATALOGS } from "./catalog.js";

describe("Messages<T>：tsc 期覆盖率检查", () => {
  const en = {
    title: "Approve tool call",
    keys: { allow: "allow", deny: "deny" },
    files: (n: number, size: string) => `${plural(n, "file")}, ${size}`,
  };

  it("zh 必须与 en 同形：缺键、多键、参数不符都是类型错误", () => {
    const zh = {
      title: "批准工具调用",
      keys: { allow: "允许", deny: "拒绝" },
      files: (n, size) => `${n} 个文件，${size}`,
    } satisfies Messages<typeof en>;
    expect(zh.files(2, "1 KB")).toBe("2 个文件，1 KB");

    // @ts-expect-error 缺 deny
    const missing = { title: "", keys: { allow: "" }, files: () => "" } satisfies Messages<
      typeof en
    >;
    const extra = {
      title: "",
      keys: { allow: "", deny: "" },
      files: () => "",
      // @ts-expect-error 多出的键
      surplus: "",
    } satisfies Messages<typeof en>;
    const wrongParam = {
      title: "",
      keys: { allow: "", deny: "" },
      // @ts-expect-error 参数类型不符（en 的第一个参数是 number）
      files: (n: string) => n,
    } satisfies Messages<typeof en>;
    const wrongLeaf = {
      // @ts-expect-error 叶子必须是字符串
      title: 1,
      keys: { allow: "", deny: "" },
      files: () => "",
    } satisfies Messages<typeof en>;
    expect([missing, extra, wrongParam, wrongLeaf]).toHaveLength(4);
  });

  it("函数叶子保持 en 的参数签名", () => {
    expectTypeOf<Messages<typeof en>["files"]>().toEqualTypeOf<
      (n: number, size: string) => string
    >();
    expectTypeOf<Messages<typeof en>["title"]>().toEqualTypeOf<string>();
  });
});

describe("全部领域", () => {
  it("catalog 登记了第六波全部 19 个领域（含功能批次的 agents / trace / memory / auth / settings）", () => {
    expect([...MESSAGE_DOMAINS].sort()).toEqual(
      [
        "agents",
        "approval",
        "auth",
        "cli",
        "config",
        "drivers",
        "errors",
        "interactive",
        "memory",
        "panels",
        "permissions",
        "plan",
        "print",
        "report",
        "rewind",
        "session",
        "settings",
        "subcommands",
        "trace",
      ].sort(),
    );
  });

  it("en 与 zh 的键集逐层相同（tsc 已保证，这里再防 as 断言绕过）", () => {
    const shape = (value: unknown): unknown =>
      typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, shape((value as Record<string, unknown>)[k])]),
          )
        : typeof value;
    expect(shape(CATALOGS.zh)).toEqual(shape(CATALOGS.en));
  });
});

describe("语言选择", () => {
  it("parseLocale 认 zh* / en*，其余 undefined", () => {
    expect(parseLocale("zh")).toBe("zh");
    expect(parseLocale("zh_CN.UTF-8")).toBe("zh");
    expect(parseLocale("ZH-tw")).toBe("zh");
    expect(parseLocale("en_US.UTF-8")).toBe("en");
    expect(parseLocale("C")).toBeUndefined();
    expect(parseLocale("")).toBeUndefined();
    expect(parseLocale(undefined)).toBeUndefined();
  });

  it("优先级：AMA_LANG > --lang > ui.language > LC_ALL > LC_MESSAGES > LANG > en", () => {
    const env = { AMA_LANG: "en", LC_ALL: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8" };
    expect(resolveLocale(env, { language: "zh" }, "zh")).toBe("en");
    expect(resolveLocale({ LANG: "en_US.UTF-8" }, { language: "en" }, "zh")).toBe("zh");
    expect(resolveLocale({ LANG: "en_US.UTF-8" }, { language: "zh" })).toBe("zh");
    expect(resolveLocale({ LANG: "zh_CN.UTF-8" }, { language: "auto" })).toBe("zh");
    expect(resolveLocale({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(resolveLocale({ LC_ALL: "", LC_MESSAGES: "zh_CN", LANG: "en_US" })).toBe("zh");
    expect(resolveLocale({ LANG: "C" })).toBe("en");
    expect(resolveLocale({ LANG: "POSIX" })).toBe("en");
    expect(resolveLocale({})).toBe("en");
  });

  it("AMA_LANG 写错时不算数，往下找", () => {
    expect(resolveLocale({ AMA_LANG: "fr", LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(resolveLocale({ AMA_LANG: "", LANG: "zh_CN.UTF-8" })).toBe("zh");
  });

  it("来源可报告（doctor 用）", () => {
    expect(resolveLocaleWithSource({ LANG: "zh_CN.UTF-8" }).source).toEqual({
      kind: "locale",
      name: "LANG",
      value: "zh_CN.UTF-8",
    });
    expect(resolveLocaleWithSource({ AMA_LANG: "zh" }).source).toMatchObject({ name: "AMA_LANG" });
    expect(resolveLocaleWithSource({}, undefined, "en").source).toEqual({ kind: "cli" });
    expect(resolveLocaleWithSource({}, { language: "zh" }).source).toEqual({ kind: "config" });
    expect(resolveLocaleWithSource({}).source).toEqual({ kind: "default" });
  });
});

describe("setLocale / msg", () => {
  afterEach(() => setLocale("zh"));

  it("测试进程缺省钉在 zh（test/helpers/setup.ts）", () => {
    expect(process.env["AMA_LANG"]).toBe("zh");
    expect(getLocale()).toBe("zh");
    expect(msg()).toBe(CATALOGS.zh);
  });

  it("setLocale 切换 msg() 的目录", () => {
    setLocale("en");
    expect(msg()).toBe(CATALOGS.en);
    expect(messagesFor("zh")).toBe(CATALOGS.zh);
  });
});

describe("format", () => {
  it("plural 只管英文复数", () => {
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "file")).toBe("2 files");
    expect(plural(2, "entry", "entries")).toBe("2 entries");
  });

  it("formatDuration compact：45s / 2m 10s / 2m / 1h24m / 3h", () => {
    expect(formatDuration(45_400)).toBe("45s");
    expect(formatDuration(130_000)).toBe("2m 10s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(84 * 60_000)).toBe("1h24m");
    expect(formatDuration(3 * 3_600_000)).toBe("3h");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });

  it("formatDuration short 与状态行一致；precise 与工具耗时一致", () => {
    expect(formatDuration(130_000, "short")).toBe("2m");
    expect(formatDuration(3_600_000, "short")).toBe("1h0m");
    expect(formatDuration(2_100, "precise")).toBe("2.1s");
    expect(formatDuration(45_900, "precise")).toBe("45s");
    expect(formatDuration(65_000, "precise")).toBe("1m05s");
  });
});

describe("[W6-C0] 读图失败的本地化（tools/image-file.ts 只给码与英文）", () => {
  const zh = messagesFor("zh").errors.imageFile;
  const en = messagesFor("en").errors.imageFile;

  it("zh 与迁移前的文案逐字节相同", () => {
    expect(zh({ reason: "missing", path: "/a.png" })).toBe("图片不存在：/a.png");
    expect(zh({ reason: "not_file", path: "/d" })).toBe("不是文件：/d");
    expect(zh({ reason: "unsupported", path: "/a.bin" })).toBe(
      "不是支持的图片（PNG / JPEG / GIF / WebP）：/a.bin",
    );
    expect(
      zh({
        reason: "too_large",
        path: "/b.png",
        limitMb: "5 MB",
        sizeMb: "5.3 MB",
        hint: "resize_off",
      }),
    ).toBe("图片超过 5 MB 上限（按 base64 后计算）：/b.png（5.3 MB）（images.resize 为 off）");
    expect(
      zh({
        reason: "too_wide",
        path: "/w.png",
        maxEdge: 8000,
        size: { width: 9000, height: 10 },
        hint: "no_tool",
      }),
    ).toBe(
      "图片任一边超过 8000 px：/w.png（9000×10）（没找到缩放工具：装 ImageMagick，macOS 自带 sips）",
    );
  });

  it("en 整句", () => {
    expect(en({ reason: "missing", path: "/a.png" })).toBe("Image not found: /a.png");
    expect(
      en({
        reason: "too_large",
        path: "/b.png",
        limitMb: "5 MB",
        sizeMb: "5.3 MB",
        hint: "still_too_large",
      }),
    ).toBe(
      "Image exceeds the 5 MB limit (counted after base64): /b.png (5.3 MB) (resizing did not bring it under the limit)",
    );
  });
});
