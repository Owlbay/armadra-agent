import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const EXPECTED = "#1 ada\nlinus, grace\nGRACE\n";

function files(dir, root = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? files(path, root) : [relative(root, path)];
  });
}

export default function check(dir) {
  const js = files(dir).filter((f) => f.endsWith(".js"));
  const stale = js.filter((f) => readFileSync(join(dir, f), "utf8").includes("fetchUser"));
  if (stale.length) return { ok: false, detail: `仍有 fetchUser：${stale.join(", ")}` };
  const renamed = js.filter((f) => readFileSync(join(dir, f), "utf8").includes("loadUser"));
  if (renamed.length < 4) return { ok: false, detail: `只有 ${renamed.length} 个文件含 loadUser` };
  const run = spawnSync(process.execPath, ["main.js"], { cwd: dir, encoding: "utf8" });
  if (run.status !== 0 || run.stdout !== EXPECTED)
    return { ok: false, detail: `node main.js 退出 ${run.status}` };
  return { ok: true, detail: "4 个文件、输出不变" };
}
