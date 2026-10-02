import { describe, expect, it } from "vitest";
import {
  NETWORK_NOT_ISOLATED,
  codemodeAvailability,
  detectSandboxCapability,
  parseNodeMajor,
  permissionFlagFor,
} from "./capability.js";

describe("detectSandboxCapability", () => {
  it("Node ≥ 25 → strict；22 / 24 → 网络未隔离", () => {
    expect(detectSandboxCapability("26.10.0")).toMatchObject({ strict: true, nodeMajor: 26 });
    expect(detectSandboxCapability("25.0.0").strict).toBe(true);
    const n24 = detectSandboxCapability("24.21.0");
    expect(n24).toMatchObject({ strict: false, nodeMajor: 24 });
    expect(n24.reason).toContain(NETWORK_NOT_ISOLATED);
    expect(detectSandboxCapability("v22.19.0")).toMatchObject({ strict: false, nodeMajor: 22 });
  });

  it("reason 只含主版本（同一主版本下字节稳定）", () => {
    expect(detectSandboxCapability("24.1.0").reason).toBe(
      detectSandboxCapability("24.21.3").reason,
    );
  });

  it("权限开关：有 --permission 用它，否则 --experimental-permission", () => {
    expect(permissionFlagFor(new Set(["--permission", "--experimental-permission"]))).toBe(
      "--permission",
    );
    expect(permissionFlagFor(new Set(["--experimental-permission"]))).toBe(
      "--experimental-permission",
    );
    expect(permissionFlagFor()).toBe("--permission"); // CI / 本机都 ≥ 22.13
  });

  it("parseNodeMajor 容错", () => {
    expect(parseNodeMajor("x")).toBe(0);
    expect(parseNodeMajor("v25.1.0")).toBe(25);
  });
});

describe("codemodeAvailability", () => {
  const loose = detectSandboxCapability("24.0.0");
  const strict = detectSandboxCapability("26.0.0");

  it("strict：可用，无 warning", () => {
    expect(codemodeAvailability(true, strict)).toEqual({ available: true, capability: strict });
  });

  it("非 strict + requireStrict → 禁用并 warning；不要求 → 可用并提示网络未隔离", () => {
    const off = codemodeAvailability(true, loose);
    expect(off.available).toBe(false);
    expect(off.warning).toMatch(/codemode 已禁用.*Node 24.*requireStrict/);
    const on = codemodeAvailability(undefined, loose);
    expect(on.available).toBe(true);
    expect(on.warning).toMatch(/网络未隔离/);
    expect(codemodeAvailability(false, loose).available).toBe(true);
  });
});
