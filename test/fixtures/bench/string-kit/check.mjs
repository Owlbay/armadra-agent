import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const NAMES = ["slugify", "camelCase", "truncate", "wordCount", "padCenter", "reverseWords"];

const CASES = {
  slugify: (f) => {
    assert.strictEqual(f.slugify("  Hello, World! 2026 "), "hello-world-2026");
    assert.strictEqual(f.slugify("a__b--c"), "a-b-c");
  },
  camelCase: (f) => {
    assert.strictEqual(f.camelCase("user_ID-value"), "userIdValue");
    assert.strictEqual(f.camelCase("  Big  red_dog "), "bigRedDog");
  },
  truncate: (f) => {
    assert.strictEqual(f.truncate("hello", 5), "hello");
    assert.strictEqual(f.truncate("hello world", 6), "hello…");
  },
  wordCount: (f) => {
    assert.strictEqual(f.wordCount(""), 0);
    assert.strictEqual(f.wordCount("   "), 0);
    assert.strictEqual(f.wordCount(" one two\tthree\nfour "), 4);
  },
  padCenter: (f) => {
    assert.strictEqual(f.padCenter("ab", 5, "*"), "*ab**");
    assert.strictEqual(f.padCenter("abc", 7), "  abc  ");
    assert.strictEqual(f.padCenter("toolong", 3), "toolong");
  },
  reverseWords: (f) => {
    assert.strictEqual(f.reverseWords("  a  b c "), "c b a");
  },
};

export default function check(dir) {
  const require = createRequire(join(resolve(dir), "package.json"));
  const path = require.resolve("./src/index.js");
  delete require.cache[path];
  let lib;
  try {
    lib = require(path);
  } catch (e) {
    return { ok: false, detail: `加载失败：${e.message}` };
  }
  const failed = [];
  for (const name of NAMES) {
    try {
      CASES[name](lib);
    } catch {
      failed.push(name);
    }
  }
  if (failed.length > 0) return { ok: false, detail: `未通过：${failed.join(", ")}` };
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const api = readme.split(/^## API\s*$/m)[1];
  if (api === undefined) return { ok: false, detail: "README 缺 ## API" };
  const missing = NAMES.filter((n) => !api.includes(`\`${n}\``));
  if (missing.length > 0) return { ok: false, detail: `README 缺 ${missing.join(", ")}` };
  return { ok: true, detail: "6 个函数与 README" };
}
