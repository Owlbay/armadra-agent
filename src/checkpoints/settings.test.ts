import { describe, expect, it } from "vitest";
import { mergeConfigLayers } from "../config/merge.js";
import { validateConfig } from "../config/schema.js";
import { resolveCheckpointSettings } from "./settings.js";

describe("resolveCheckpointSettings", () => {
  it("缺省 tools / 5 MiB / 100", () => {
    expect(resolveCheckpointSettings(undefined, {})).toEqual({
      mode: "tools",
      maxFileBytes: 5_242_880,
      keep: 100,
    });
  });

  it("AMA_CHECKPOINTS 覆盖；无效值 warn 后忽略", () => {
    const config = { checkpoints: { mode: "tools" as const, keep: 5 } };
    expect(resolveCheckpointSettings(config, { AMA_CHECKPOINTS: "off" }).mode).toBe("off");
    const warnings: string[] = [];
    const s = resolveCheckpointSettings(config, { AMA_CHECKPOINTS: "nope" }, (m) =>
      warnings.push(m),
    );
    expect(s).toEqual({ mode: "tools", maxFileBytes: 5_242_880, keep: 5 });
    expect(warnings[0]).toContain("AMA_CHECKPOINTS=nope");
  });
});

describe("checkpoints 配置段", () => {
  it("校验取值", () => {
    expect(
      validateConfig({ version: 1, checkpoints: { mode: "off", maxFileBytes: 10, keep: 3 } }),
    ).toEqual([]);
    const bad = validateConfig({ version: 1, checkpoints: { mode: "git", keep: 0, extra: 1 } });
    expect(bad.map((d) => `${d.severity}:${d.path}`).sort()).toEqual([
      "error:checkpoints.keep",
      "error:checkpoints.mode",
      "warning:checkpoints.extra",
    ]);
  });

  it("项目级只能关闭、只能调小 maxFileBytes，keep 被忽略", () => {
    const merged = mergeConfigLayers({
      user: { version: 1, checkpoints: { maxFileBytes: 1000, keep: 50 } },
      project: { version: 1, checkpoints: { mode: "off", maxFileBytes: 500, keep: 1 } },
    });
    expect(merged.config.checkpoints).toEqual({ mode: "off", maxFileBytes: 500, keep: 50 });
    expect(merged.warnings.join("\n")).toContain("checkpoints.keep");

    const loose = mergeConfigLayers({
      project: { version: 1, checkpoints: { mode: "shadow-git", maxFileBytes: 99_999_999 } },
    });
    expect(loose.config.checkpoints).toBeUndefined();
    expect(loose.warnings).toHaveLength(2);
  });
});
