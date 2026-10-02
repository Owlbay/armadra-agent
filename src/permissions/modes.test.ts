import { describe, expect, it } from "vitest";
import {
  PERMISSION_MODE_CYCLE,
  PERMISSION_MODE_INFO,
  PERMISSION_MODE_ORDER,
  isPermissionMode,
  nextCycleMode,
  parsePermissionMode,
  permissionModeLabel,
} from "./modes.js";
import { isAtLeastAsStrict } from "./rules.js";
import { PERMISSION_MODES_STRICT_FIRST } from "./types.js";

describe("权限模式表", () => {
  it("六种模式都有显示名与说明；界面顺序覆盖全部", () => {
    expect([...PERMISSION_MODE_ORDER].sort()).toEqual([...PERMISSION_MODES_STRICT_FIRST].sort());
    expect(PERMISSION_MODE_ORDER.map(permissionModeLabel)).toEqual([
      "Manual",
      "Accept edits",
      "Plan",
      "Auto",
      "Bypass permissions",
      "Allowlist only",
    ]);
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(PERMISSION_MODE_INFO[mode].description.length).toBeGreaterThan(0);
    }
  });

  it("严格度：plan < allowlist < default < auto-edit < auto < full-auto", () => {
    expect(PERMISSION_MODES_STRICT_FIRST).toEqual([
      "plan",
      "allowlist",
      "default",
      "auto-edit",
      "auto",
      "full-auto",
    ]);
    expect(isAtLeastAsStrict("allowlist", "default")).toBe(true);
    expect(isAtLeastAsStrict("plan", "allowlist")).toBe(true);
    expect(isAtLeastAsStrict("auto", "auto-edit")).toBe(false);
  });

  it("Shift+Tab：Manual → Accept edits → Plan → Auto → Bypass → Manual；allowlist 回到 Manual", () => {
    expect(PERMISSION_MODE_CYCLE).not.toContain("allowlist");
    const seen = ["default"];
    let mode = nextCycleMode("default");
    while (mode !== "default") {
      seen.push(mode);
      mode = nextCycleMode(mode);
    }
    expect(seen).toEqual(["default", "auto-edit", "plan", "auto", "full-auto"]);
    expect(nextCycleMode("allowlist")).toBe("default");
  });

  it("参数解析接受值与显示名", () => {
    expect(parsePermissionMode("auto")).toBe("auto");
    expect(parsePermissionMode("Accept edits")).toBe("auto-edit");
    expect(parsePermissionMode("bypass-permissions")).toBe("full-auto");
    expect(parsePermissionMode("allowlist only")).toBe("allowlist");
    expect(parsePermissionMode("manual")).toBe("default");
    expect(parsePermissionMode("yolo")).toBeUndefined();
    expect(isPermissionMode("allowlist")).toBe(true);
    expect(isPermissionMode("Auto")).toBe(false);
  });
});
