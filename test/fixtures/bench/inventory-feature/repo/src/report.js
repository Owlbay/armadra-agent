"use strict";
const { listItems } = require("./inventory.js");

function renderReport(inv) {
  const lines = listItems(inv).map((item) => `${item.sku} ${item.name} x${item.qty} @ ${item.price.toFixed(2)}`);
  return lines.join("\n");
}

module.exports = { renderReport };
