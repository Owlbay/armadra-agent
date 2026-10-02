/**
 * [W5-F] plan 扩展测试装配：真实权限管线 + plan 扩展 + 临时数据目录。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionPipeline } from "../../permissions/pipeline.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { PlanExtensionOptions } from "../../plan/controller.js";
import { createPlanExtensionFactory, planController } from "../session-plan.js";
import { createHarness, type HarnessOptions } from "./harness.js";

const dirs: string[] = [];
export function cleanupPlanDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ama-plan-ext-"));
  dirs.push(dir);
  return dir;
}

export function planHarness(
  script: HarnessOptions["script"],
  options: Partial<PlanExtensionOptions> & { mode?: PermissionMode; dir?: string } = {},
) {
  const { mode = "default", dir, ...plan } = options;
  const permission = new PermissionPipeline({ mode, rules: [], cwd: "/work" });
  const h = createHarness({
    script,
    permission,
    ...(dir !== undefined ? { dir } : {}),
    extensions: [createPlanExtensionFactory({ dataDir: tmp(), ...plan })],
  });
  return { ...h, permission, plan: planController(h.session)! };
}
