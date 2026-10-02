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
 * - **泄漏护栏**：测试给 bootstrap / createRuntimeDeps 传显式 `env` 时不经过上面的 process.env，
 *   漏带 `AMA_DATA_DIR` / `HOME` 就会回落到真实目录。文件开始前记下真实 `~/.local/share/ama`、
 *   `~/.local/share/ama/sessions`、`~/.config/ama`（按 `os.userInfo().homedir`，不受 HOME 影响）的条目，
 *   afterAll 再看一次：新增的会话目录名来自临时目录（cwd 在 os.tmpdir() 下）或两个根目录出现任何新条目，
 *   本文件失败并列出泄漏路径。只认临时目录来源的会话，避免把同时在用的真实 ama 误判为泄漏。
 */

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { sessionDirForCwd } from "../../src/session/store.js";
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

const realHome = userInfo().homedir;
const REAL_ROOTS = [join(realHome, ".local", "share", "ama"), join(realHome, ".config", "ama")];
const REAL_SESSIONS = join(realHome, ".local", "share", "ama", "sessions");
const TMP_PREFIXES = [...new Set([tmpdir(), realpathSync(tmpdir())])].map((dir) =>
  sessionDirForCwd("", dir),
);

function entries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function snapshot(): Set<string> {
  return new Set([...REAL_ROOTS.flatMap(entries), ...entries(REAL_SESSIONS)]);
}

const before = snapshot();

/** 本测试文件期间在真实目录里新增、且确属测试的条目。 */
export function leakedRealPaths(): string[] {
  return [...snapshot()]
    .filter((path) => !before.has(path))
    .filter((path) => {
      if (path.startsWith(REAL_SESSIONS + "/") || path.startsWith(REAL_SESSIONS + "\\")) {
        const name = path.slice(REAL_SESSIONS.length + 1);
        return TMP_PREFIXES.some((prefix) => name.startsWith(prefix));
      }
      return path !== REAL_SESSIONS;
    });
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  const leaked = leakedRealPaths();
  if (leaked.length > 0) {
    throw new Error(
      `测试写进了真实的 ama 目录（显式 env 漏带 AMA_DATA_DIR / AMA_CONFIG_DIR / HOME？）：\n${leaked.join("\n")}`,
    );
  }
});
