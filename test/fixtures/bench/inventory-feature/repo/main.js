"use strict";
const { createInventory, addItem } = require("./src/inventory.js");
const { renderReport } = require("./src/report.js");

const inv = createInventory();
addItem(inv, "pen", "Gel pen", 1.5, 4);
addItem(inv, "pad", "Note pad", 3.25, 2);
addItem(inv, "ink", "Ink bottle", 7, 10);
addItem(inv, "cap", "Pen cap", 0.2, 1);

console.log(renderReport(inv));
