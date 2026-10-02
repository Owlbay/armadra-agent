import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXPECTED = [
  "src/jobs/cleanup.js: CLEANUP_DRY_RUN",
  "src/jobs/cleanup.js: RETENTION_DAYS",
  "src/log.js: LOG_LEVEL",
  "src/server/auth.js: SESSION_SECRET",
  "src/server/http.js: PORT",
];

export default function check(dir) {
  const file = join(dir, "SUMMARY.md");
  if (!existsSync(file)) return { ok: false, detail: "没有 SUMMARY.md" };
  const pairs = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.replace(/^[-*\s`]+|[`\s]+$/g, "").replace(/^\.\//, ""))
    .map((line) => line.replace(/\s*:\s*/, ": "))
    .filter((line) => /^[\w./-]+\.js: [A-Z_]+$/.test(line));
  const got = [...new Set(pairs)].sort();
  const missing = EXPECTED.filter((p) => !got.includes(p));
  const extra = got.filter((p) => !EXPECTED.includes(p));
  if (missing.length || extra.length)
    return { ok: false, detail: `缺 ${missing.length}、多 ${extra.length}` };
  return { ok: true, detail: "5 / 5" };
}
