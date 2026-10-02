#!/usr/bin/env node
// esbuild：src/bundle.ts → dist/bundle/ama.cjs（设计 §2、§14、D2）；
// 第二入口 src/codemode/sandbox-entry.ts → dist/bundle/ama-sandbox.cjs（codemode 子进程，设计 §5.5）。
// platform node、format cjs、target node22、全部内联（零运行时依赖，任何非 node: 的外部引用都算失败）。
// `import.meta.url` 替换为 __filename 的 file URL；`__AMA_VERSION__` / `__AMA_BUNDLED__` 在此定义。
// [W6-C0] `charset: "utf8"`：中文与符号按 UTF-8 原样输出（缺省 ascii 会转成 \uXXXX，每字 6 字节）；
// Node 按 UTF-8 读源码，require 无影响（docs/wave6-plan.md §5.1、§5.6）。

import { chmodSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "bundle", "ama.cjs");
const sandboxOutfile = join(root, "dist", "bundle", "ama-sandbox.cjs");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const result = await build({
  absWorkingDir: root,
  entryPoints: [join(root, "src", "bundle.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  charset: "utf8",
  metafile: true,
  logLevel: "warning",
  banner: {
    js: [
      "#!/usr/bin/env node",
      'const __ama_import_meta_url = require("node:url").pathToFileURL(__filename).href;',
    ].join("\n"),
  },
  define: {
    "import.meta.url": "__ama_import_meta_url",
    __AMA_VERSION__: JSON.stringify(pkg.version),
    __AMA_BUNDLED__: "true",
    // host-side.ts 据此在 ama.cjs 同目录找子进程入口
    __AMA_SANDBOX_ENTRY__: JSON.stringify("ama-sandbox.cjs"),
  },
});

// codemode 子进程入口：权限模型只允许它读自己，所以必须是自包含的单文件（只引用 node: 内置模块）。
const sandboxResult = await build({
  absWorkingDir: root,
  entryPoints: [join(root, "src", "codemode", "sandbox-entry.ts")],
  outfile: sandboxOutfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  charset: "utf8",
  metafile: true,
  logLevel: "warning",
});

// 守住「全部内联」：输入只能来自 src/，外部引用只能是 node: 内置模块。
const problems = [];
for (const { metafile } of [result, sandboxResult]) {
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.startsWith("src/")) problems.push(`非 src 输入被打进 bundle：${input}`);
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const imp of output.imports ?? []) {
      if (imp.external && !imp.path.startsWith("node:")) {
        problems.push(`外部引用：${imp.path}（只允许 node: 内置模块）`);
      }
    }
  }
}
// 子进程入口只能读自己：除 sandbox-entry.ts（与只含类型的 protocol.ts）外不许有其它 src 输入。
for (const input of Object.keys(sandboxResult.metafile.inputs)) {
  if (input !== "src/codemode/sandbox-entry.ts") {
    problems.push(`ama-sandbox.cjs 不应包含 ${input}（子进程入口必须自包含）`);
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error(`build-bundle: ${p}`);
  process.exit(1);
}

chmodSync(outfile, 0o755);
for (const file of [outfile, sandboxOutfile]) {
  const size = statSync(file).size;
  console.log(`build-bundle: ${relative(root, file)} ${(size / 1024).toFixed(1)} KiB`);
}
