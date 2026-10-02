/**
 * vitest setupFiles（每个测试文件执行一次）。[B0] 所有。
 *
 * - `AMA_CONFIG_DIR` / `AMA_DATA_DIR` 指向本测试文件独享的临时目录，测试不会读写真实的
 *   `~/.config/ama` 与 `~/.local/share/ama`。
 * - 清空各家 API Key 环境变量（`*_API_KEY`、`AMA_API_KEY_*` 以及 §3.3 里不以 _API_KEY 结尾的
 *   候选名），测试不会意外用到开发者本机的真 key。
 * - `AMA_NO_INIT=1`：CLI 不自动初始化配置目录（`AMA_CONFIG_DIR` 指向的目录此时还不存在）。
 * - 清掉 `AMA_LOG` / `AMA_LOG_FILE` / `AMA_SHELL` 与 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`
 *   （内置供应商据此改 baseUrl，W3-B12），避免本机设置影响断言。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { isApiKeyVar } from "./tmp-home.js";

const CLEARED_VARS = [
  "AMA_LOG",
  "AMA_LOG_FILE",
  "AMA_SHELL",
  "AMA_E2E_PROVIDER",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
];

for (const name of Object.keys(process.env)) {
  if (isApiKeyVar(name)) delete process.env[name];
}
for (const name of CLEARED_VARS) delete process.env[name];

const root = mkdtempSync(join(tmpdir(), "ama-test-"));
process.env["AMA_CONFIG_DIR"] = join(root, "config");
process.env["AMA_DATA_DIR"] = join(root, "data");
// CLI 首次运行的自动初始化（config/init.ts）不在测试里触发；init.test.ts 显式传 env 覆盖。
process.env["AMA_NO_INIT"] = "1";

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
