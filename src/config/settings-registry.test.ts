import { describe, expect, it } from "vitest";
import { buildConfigJsonSchema } from "./json-schema.js";
import { documentedLeaves } from "./key-docs.js";
import { restrictProjectConfig } from "./merge.js";
import {
  SETTING_GROUPS,
  schemaAt,
  settableKeys,
  settingsRegistry,
  type SettingSpec,
} from "./settings-registry.js";
import type { AmaConfig } from "./types.js";

function setPath(key: string, value: unknown): AmaConfig {
  const out: Record<string, unknown> = { version: 1 };
  const parts = key.split(".");
  let node = out;
  for (const part of parts.slice(0, -1)) node = (node[part] = {}) as Record<string, unknown>;
  node[parts.at(-1) as string] = value;
  return out as unknown as AmaConfig;
}

function getPath(value: unknown, key: string): unknown {
  let node = value;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Sample values: every enum value, both booleans, a small and a large number. */
function samples(spec: SettingSpec): unknown[] {
  switch (spec.kind) {
    case "bool":
      return [true, false];
    case "enum":
      return [...(spec.options ?? [])];
    case "number":
    case "optionalNumber":
      return [spec.minimum ?? 0, spec.maximum ?? 1_000_000_000];
    case "model":
      return ["anthropic/claude-x"];
    case "text":
      return ["Chinese"];
  }
}

describe("settings registry", () => {
  const registry = settingsRegistry();

  it("keys are documented leaves, unique, in a known group", () => {
    const leaves = new Set(documentedLeaves());
    const keys = registry.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const spec of registry) {
      expect(leaves.has(spec.key), spec.key).toBe(true);
      expect(SETTING_GROUPS).toContain(spec.group);
    }
    for (const key of keys) expect(settableKeys()).toContain(key);
    expect(registry.length).toBeGreaterThanOrEqual(48);
  });

  it("kind and options agree with the JSON Schema", () => {
    const root = buildConfigJsonSchema();
    for (const spec of registry) {
      const schema = schemaAt(spec.key, root)!;
      const type = schema["type"];
      const anyOf = schema["anyOf"] as Record<string, unknown>[] | undefined;
      switch (spec.kind) {
        case "bool":
          expect(type, spec.key).toBe("boolean");
          break;
        case "enum":
          expect(spec.options, spec.key).toEqual(schema["enum"]);
          break;
        case "number":
          expect(type, spec.key).toBe("number");
          break;
        case "optionalNumber":
          expect(type === "number" || anyOf?.some((s) => s["type"] === "number"), spec.key).toBe(
            true,
          );
          break;
        case "model":
        case "text":
          expect(type, spec.key).toBe("string");
          expect(schema["enum"], spec.key).toBeUndefined();
          break;
      }
    }
  });

  it("project writability matches restrictProjectConfig", () => {
    for (const spec of registry) {
      const verdicts = samples(spec).map((value) => {
        const { accepted } = restrictProjectConfig(setPath(spec.key, value), "default");
        return JSON.stringify(getPath(accepted, spec.key)) === JSON.stringify(value);
      });
      if (spec.project === "any") expect(verdicts.every(Boolean), spec.key).toBe(true);
      else if (spec.project === "deny") expect(verdicts.some(Boolean), spec.key).toBe(false);
      else {
        expect(verdicts.some(Boolean), `${spec.key} accepts something`).toBe(true);
        expect(verdicts.every(Boolean), `${spec.key} rejects something`).toBe(false);
      }
    }
  });

  it("derives enum options, bounds and keywords", () => {
    const byKey = new Map(registry.map((s) => [s.key, s]));
    expect(byKey.get("ui.theme")?.options).toEqual(["dark", "light", "auto"]);
    expect(byKey.get("retry.maxRetries")).toMatchObject({ minimum: 0, maximum: 100 });
    expect(byKey.get("compaction.prune.clearAtLeast")).toMatchObject({
      kind: "optionalNumber",
      keywords: ["auto"],
    });
    expect(byKey.get("defaultModel")).toMatchObject({ kind: "model", prefix: true, apply: "now" });
    expect(byKey.get("ui.theme")?.apply).toBe("restart");
  });
});
