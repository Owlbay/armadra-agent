"use strict";

const level = process.env.LOG_LEVEL ?? "info";

function log(message) {
  if (level !== "silent") console.log(message);
}

module.exports = { log };
