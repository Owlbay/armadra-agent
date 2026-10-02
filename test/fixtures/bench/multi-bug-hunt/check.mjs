import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const original = readFileSync(fileURLToPath(new URL("repo/test.js", import.meta.url)), "utf8");

export default function check(dir) {
  if (readFileSync(join(dir, "test.js"), "utf8") !== original)
    return { ok: false, detail: "test.js 被改动" };
  const run = spawnSync(process.execPath, ["test.js"], { cwd: dir, encoding: "utf8" });
  if (run.status !== 0 || run.stdout.trim() !== "ok")
    return { ok: false, detail: `node test.js 退出 ${run.status}` };
  return { ok: true, detail: "node test.js → ok" };
}
