"use strict";
/** Total price in cents; each item is { price, qty }. Discount is a fraction (0.1 = 10% off). */
function cartTotal(items, discount = 0) {
  const gross = items.reduce((sum, item) => sum + item.price, 0);
  return Math.round(gross * (1 - discount));
}
module.exports = { cartTotal };
