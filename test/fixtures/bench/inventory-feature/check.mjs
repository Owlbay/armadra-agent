import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const EXPECTED = [
  "ink Ink bottle x10 @ 7.00",
  "pad Note pad x2 @ 3.25",
  "pen Gel pen x2 @ 1.50",
  "Low stock: pad, pen",
  "Total: 79.50",
].join("\n");

export default function check(dir) {
  const require = createRequire(join(resolve(dir), "package.json"));
  let inv;
  try {
    const path = require.resolve("./src/inventory.js");
    delete require.cache[path];
    inv = require(path);
  } catch (e) {
    return { ok: false, detail: `加载失败：${e.message}` };
  }
  for (const name of ["removeItem", "totalValue", "lowStock"])
    if (typeof inv[name] !== "function") return { ok: false, detail: `未导出 ${name}` };
  const m = inv.createInventory();
  inv.addItem(m, "b", "B", 2, 1);
  inv.addItem(m, "a", "A", 1, 5);
  let threw = "";
  try {
    inv.removeItem(m, "b", 2);
  } catch (e) {
    threw = e.message;
  }
  if (threw !== "insufficient stock") return { ok: false, detail: "removeItem 不足时未按约定抛错" };
  try {
    inv.removeItem(m, "zz", 1);
    return { ok: false, detail: "removeItem 缺货未抛错" };
  } catch {}
  inv.removeItem(m, "b", 1);
  if (m.has("b")) return { ok: false, detail: "数量为 0 未删除" };
  if (inv.totalValue(m) !== 5) return { ok: false, detail: "totalValue 不对" };
  if (JSON.stringify(inv.lowStock(m, 10)) !== '["a"]') return { ok: false, detail: "lowStock 不对" };
  const run = spawnSync(process.execPath, ["main.js"], { cwd: dir, encoding: "utf8" });
  if (run.status !== 0 || run.stdout.trim() !== EXPECTED)
    return { ok: false, detail: `node main.js 输出不符（退出 ${run.status}）` };
  const log = readFileSync(join(dir, "CHANGELOG.md"), "utf8").split(/^## Unreleased\s*$/m)[1] ?? "";
  const missing = ["removeItem", "totalValue", "lowStock"].filter((n) => !log.includes(n));
  if (missing.length > 0) return { ok: false, detail: `CHANGELOG 缺 ${missing.join(", ")}` };
  return { ok: true, detail: "函数、报告与 CHANGELOG" };
}
