/**
 * 配置校验的诊断收集器（从 schema.ts 抽出，schema-w5.ts 共用）。[W5-C0]
 */

export interface Diagnostic {
  severity: "error" | "warning";
  /** 字段路径；文件级问题为 ""。 */
  path: string;
  message: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type Obj = Record<string, unknown>;

export class Checker {
  readonly diagnostics: Diagnostic[] = [];

  error(path: string, message: string): void {
    this.diagnostics.push({ severity: "error", path, message });
  }

  warn(path: string, message: string): void {
    this.diagnostics.push({ severity: "warning", path, message });
  }

  object(value: unknown, path: string): value is Obj {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return true;
    this.error(path, "应为对象");
    return false;
  }

  /** 未知字段只警告（前向兼容）。 */
  keys(value: Obj, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.warn(join(path, key), "未知字段，已忽略");
    }
  }

  version(value: Obj, path: string): void {
    if (value["version"] !== 1) this.error(join(path, "version"), "version 必须为 1");
  }

  string(value: Obj, key: string, path: string, required = false): void {
    const v = value[key];
    if (v === undefined) {
      if (required) this.error(join(path, key), "缺少必填字符串");
      return;
    }
    if (typeof v !== "string") this.error(join(path, key), "应为字符串");
  }

  boolean(value: Obj, key: string, path: string): void {
    const v = value[key];
    if (v !== undefined && typeof v !== "boolean") this.error(join(path, key), "应为布尔值");
  }

  number(value: Obj, key: string, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): void {
    const v = value[key];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.error(join(path, key), "应为数字");
    } else if (v < min || v > max) {
      this.error(join(path, key), `应在 ${min}–${max} 之间`);
    }
  }

  oneOf(value: Obj, key: string, path: string, choices: readonly string[]): void {
    const v = value[key];
    if (v === undefined) return;
    if (typeof v !== "string" || !choices.includes(v)) {
      this.error(join(path, key), `取值应为 ${choices.join(" | ")}`);
    }
  }

  stringArray(value: Obj, key: string, path: string): void {
    const v = value[key];
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
      this.error(join(path, key), "应为字符串数组");
    }
  }

  stringRecord(value: Obj, key: string, path: string): void {
    const v = value[key];
    if (v === undefined) return;
    if (!this.object(v, join(path, key))) return;
    for (const [k, item] of Object.entries(v)) {
      if (typeof item !== "string") this.error(join(join(path, key), k), "应为字符串");
    }
  }
}

export function join(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path === "" ? key : `${path}.${key}`;
}

export function checkSection(
  c: Checker,
  config: Obj,
  key: string,
  allowed: readonly string[],
  body: (section: Obj, path: string) => void,
): void {
  const section = config[key];
  if (section === undefined) return;
  if (!c.object(section, key)) return;
  c.keys(section, key, allowed);
  body(section, key);
}
