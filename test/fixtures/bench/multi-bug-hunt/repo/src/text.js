"use strict";
/** Capitalizes the first letter of every word separated by spaces. */
function titleCase(text) {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toUpperCase())
    .join(" ");
}
module.exports = { titleCase };
