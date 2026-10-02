/** `sandbox` 配置段（docs/sandbox.md「配置」）：校验与项目级限制。 */

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
    expect(result.warnings).toEqual([".ama/config.json: 项目级不能设 sandbox，已忽略"]);
  });
});
