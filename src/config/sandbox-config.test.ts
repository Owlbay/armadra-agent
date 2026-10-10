/** `sandbox` 配置段（docs/guides/sandbox.md「配置」）：校验与项目级限制。 */

import { describe, expect, it } from "vitest";
import { buildConfigJsonSchema } from "./json-schema.js";
import { restrictProjectConfig } from "./merge.js";
import { validateConfig } from "./schema.js";

describe("sandbox.enabled", () => {
  it("auto / off 合法，其它取值是 error", () => {
    expect(validateConfig({ version: 1, sandbox: { enabled: "off" } })).toEqual([]);
    expect(validateConfig({ version: 1, sandbox: { enabled: "auto" } })).toEqual([]);
    const bad = validateConfig({ version: 1, sandbox: { enabled: "on" } });
    expect(bad.map((d) => [d.severity, d.path])).toEqual([["error", "sandbox.enabled"]]);
  });

  it("JSON Schema 有这一段", () => {
    const schema = buildConfigJsonSchema() as {
      properties: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
    };
    expect(schema.properties["sandbox"]?.properties?.["enabled"]?.enum).toEqual(["auto", "off"]);
  });

  it("项目级不能设（防止仓库关掉用户的沙箱）", () => {
    const result = restrictProjectConfig({ version: 1, sandbox: { enabled: "off" } }, "default");
    expect(result.accepted).toEqual({});
    expect(result.warnings).toEqual([
      '.ama/config.json: 项目级只接受 sandbox.network "deny"，忽略 sandbox.enabled',
    ]);
  });
});

describe("[S2] sandbox.bash / network / writable", () => {
  it("合法取值无诊断；非法取值是 error；相对路径 warning", () => {
    expect(
      validateConfig({
        version: 1,
        sandbox: { bash: "auto", network: "allow", writable: ["/opt/cache", "~/.npm", "~"] },
      }),
    ).toEqual([]);
    const bad = validateConfig({
      version: 1,
      sandbox: { bash: "on", network: "block", writable: [3] },
    } as never);
    expect(bad.map((d) => [d.severity, d.path])).toEqual([
      ["error", "sandbox.bash"],
      ["error", "sandbox.network"],
      ["error", "sandbox.writable"],
    ]);
    const rel = validateConfig({ version: 1, sandbox: { writable: ["rel/dir"] } });
    expect(rel.map((d) => [d.severity, d.path])).toEqual([["warning", "sandbox.writable[0]"]]);
  });

  it("JSON Schema 带新键", () => {
    const schema = buildConfigJsonSchema() as {
      properties: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
    };
    const section = schema.properties["sandbox"]?.properties ?? {};
    expect(section["bash"]?.enum).toEqual(["auto", "off"]);
    expect(section["network"]?.enum).toEqual(["deny", "allow"]);
    expect(section["writable"]).toBeDefined();
  });

  it("项目级只接受收紧的 network: deny，其余忽略并 warning", () => {
    const tighten = restrictProjectConfig({ version: 1, sandbox: { network: "deny" } }, "default");
    expect(tighten.accepted).toEqual({ sandbox: { network: "deny" } });
    expect(tighten.warnings).toEqual([]);
    const loosen = restrictProjectConfig(
      {
        version: 1,
        sandbox: { bash: "off", network: "allow", writable: ["/"], enabled: "auto" },
      },
      "default",
    );
    expect(loosen.accepted).toEqual({});
    expect(loosen.warnings).toEqual([
      '.ama/config.json: 项目级只接受 sandbox.network "deny"，忽略 sandbox.bash',
      '.ama/config.json: 项目级只接受 sandbox.network "deny"，忽略 sandbox.network allow',
      '.ama/config.json: 项目级只接受 sandbox.network "deny"，忽略 sandbox.writable',
      '.ama/config.json: 项目级只接受 sandbox.network "deny"，忽略 sandbox.enabled',
    ]);
  });
});
