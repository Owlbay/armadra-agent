Extend this small inventory project. Do all of the following:

1. In `src/inventory.js`, add `removeItem(inv, sku, qty)`: it lowers the item's quantity by `qty`; it throws an `Error` whose message is `insufficient stock` if the item is missing or has fewer than `qty` units; when the quantity reaches 0 the item is deleted from the inventory.
2. In `src/inventory.js`, add `totalValue(inv)`: the sum of `price * qty` over all items.
3. In `src/inventory.js`, add `lowStock(inv, threshold)`: the skus whose quantity is below `threshold`, sorted alphabetically.
4. Export the three new functions from `src/inventory.js`.
5. In `src/report.js`, after the item lines, add a line `Low stock: <skus joined by ", ">` for threshold 3 (or `Low stock: none` when there are none), then a final line `Total: <totalValue with 2 decimals>`.
6. In `main.js`, remove 2 units of `pen` and all units of `cap` before printing the report.
7. Under `## Unreleased` in `CHANGELOG.md`, add one bullet per new function naming it.

Run `node main.js` at the end to check the output.
