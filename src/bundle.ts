/**
 * 单文件入口（dist/bundle/ama.cjs）。[B0] 所有。
 *
 * esbuild 以本文件为入口打成 CJS：`import.meta.url` 由构建脚本替换为 `__filename` 的
 * file URL，`__AMA_BUNDLED__` 定义为 true（cli/main.ts 据此不自动运行，改由这里调用）。
 * CJS 产物里原生 `require` 可用，宿主适配器（`--host`）的 CJS 模块由 host/loader.ts（B5）
 * 用 `createRequire` 加载，不依赖这里。
 */

import { main } from "./cli/main.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`ama: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
