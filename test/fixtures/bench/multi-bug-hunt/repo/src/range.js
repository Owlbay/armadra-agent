"use strict";
/** Integers from start (inclusive) to end (inclusive). */
function range(start, end) {
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
module.exports = { range };
