/**
 * 并发刷新测试的子进程入口（esbuild 打包后由 `node` 运行）：对同一 auth.json 取一次新鲜条目，
 * 只把 access token 的 SHA-256 打到 stdout（token 原文不进测试输出）。
 */

import { createHash } from "node:crypto";
import { freshOAuthEntry } from "../oauth/refresh.js";

const [authFile, provider] = process.argv.slice(2);
freshOAuthEntry(authFile ?? "", provider ?? "chatgpt").then(
  (entry) => {
    const hash = createHash("sha256")
      .update(entry?.accessToken ?? "")
      .digest("hex");
    process.stdout.write(`${hash}\n`);
  },
  (error: unknown) => {
    process.stdout.write(`error ${(error as { code?: string }).code ?? "unknown"}\n`);
    process.exitCode = 1;
  },
);
