"use strict";
const assert = require("node:assert");
const { range } = require("./src/range.js");
const { isoDay } = require("./src/dates.js");
const { cartTotal } = require("./src/cart.js");
const { titleCase } = require("./src/text.js");
const { Lru } = require("./src/cache.js");
const { chunk } = require("./src/queue.js");

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message.split("\n")[0]}`);
  }
}

check("range", () => assert.deepStrictEqual(range(2, 5), [2, 3, 4, 5]));
check("isoDay", () => assert.strictEqual(isoDay(new Date(Date.UTC(2026, 0, 9))), "2026-01-09"));
check("cartTotal", () =>
  assert.strictEqual(cartTotal([{ price: 250, qty: 2 }, { price: 100, qty: 1 }], 0.1), 540),
);
check("titleCase", () => assert.strictEqual(titleCase("hello big world"), "Hello Big World"));
check("lru", () => {
  const lru = new Lru(2);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.get("a");
  lru.set("c", 3);
  assert.strictEqual(lru.get("a"), 1);
  assert.strictEqual(lru.get("b"), undefined);
});
check("chunk", () => assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));

if (failures.length > 0) {
  console.log(failures.join("\n"));
  process.exit(1);
}
console.log("ok");
