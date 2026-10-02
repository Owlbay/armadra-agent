"use strict";
/** Least-recently-used cache holding at most `limit` entries. */
class Lru {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }
  get(key) {
    return this.map.get(key);
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
}
module.exports = { Lru };
