"use strict";
const assert = require("node:assert");
const { sum, mean, median } = require("./src/stats.js");
const { percent } = require("./src/format.js");

assert.strictEqual(sum([1, 2, 3]), 6);
assert.strictEqual(mean([2, 4]), 3);
assert.strictEqual(median([5, 1, 3]), 3);
assert.strictEqual(median([4, 1, 3, 2]), 2.5);
assert.strictEqual(median([10, 20]), 15);
assert.strictEqual(percent(0.256), "25.6%");
console.log("ok");
