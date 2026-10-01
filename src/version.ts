/**
 * 包版本。[B0] 所有。
 *
 * 补全说明：§1.2 没有这个文件，但 `ama --version`、`HostApi.agent.version`、会话头
 * `agent.version` 都要它。bundle 构建时 esbuild 把 `__AMA_VERSION__` 定义为字面量；
 * 未打包时（dist/ 或 vitest 跑 src/）从包根的 package.json 读取——两处都在本文件的 `../`。
 */

import { readFileSync } from "node:fs";

declare const __AMA_VERSION__: string | undefined;

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const pkg: unknown = JSON.parse(raw);
    if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
      const { version } = pkg as { version: unknown };
      if (typeof version === "string") return version;
    }
  } catch {
    // 落到下面的兜底值
  }
  return "0.0.0-unknown";
}

export const AMA_VERSION: string =
  typeof __AMA_VERSION__ === "string" ? __AMA_VERSION__ : readPackageVersion();
