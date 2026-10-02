/**
 * 端到端冒烟的子进程辅助：跑 dist/bundle/ama.cjs（先 `pnpm build`），临时 HOME 隔离配置与会话。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TmpHome } from "../helpers/tmp-home.js";

export const BUNDLE = fileURLToPath(new URL("../../dist/bundle/ama.cjs", import.meta.url));
export const hasBundle = existsSync(BUNDLE);

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runAma(
  home: TmpHome,
  argv: string[],
  options: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...argv], {
      cwd: home.cwd,
      env: { ...home.env, AMA_NO_LOCAL_PROBE: "1", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ama 超时：${argv.join(" ")}\n${stderr}`));
    }, options.timeoutMs ?? 15_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}
