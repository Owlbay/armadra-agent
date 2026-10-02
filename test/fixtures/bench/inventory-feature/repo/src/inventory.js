"use strict";
/** An inventory is a Map from sku to { name, price, qty } (price in dollars). */
function createInventory() {
  return new Map();
}

function addItem(inv, sku, name, price, qty) {
  const existing = inv.get(sku);
  if (existing) existing.qty += qty;
  else inv.set(sku, { name, price, qty });
}

function listItems(inv) {
  return [...inv.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sku, item]) => ({ sku, ...item }));
}

module.exports = { createInventory, addItem, listItems };
