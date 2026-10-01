#!/usr/bin/env node
// esbuild：src/bundle.ts → dist/bundle/ama.cjs（设计 §2、§14、D2）。
// platform node、format cjs、target node22、全部内联（零运行时依赖，任何非 node: 的外部引用都算失败）。
// `import.meta.url` 替换为 __filename 的 file URL；`__AMA_VERSION__` / `__AMA_BUNDLED__` 在此定义。

import { chmodSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "bundle", "ama.cjs");
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
  },
});

// 守住「全部内联」：输入只能来自 src/，外部引用只能是 node: 内置模块。
const problems = [];
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith("src/")) problems.push(`非 src 输入被打进 bundle：${input}`);
}
for (const output of Object.values(result.metafile.outputs)) {
  for (const imp of output.imports ?? []) {
    if (imp.external && !imp.path.startsWith("node:")) {
      problems.push(`外部引用：${imp.path}（只允许 node: 内置模块）`);
    }
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error(`build-bundle: ${p}`);
  process.exit(1);
}

chmodSync(outfile, 0o755);
const size = statSync(outfile).size;
console.log(`build-bundle: ${relative(root, outfile)} ${(size / 1024).toFixed(1)} KiB`);
