"use strict";

function percent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

module.exports = { percent };
