"use strict";
/** Formats a Date as YYYY-MM-DD (UTC). */
function isoDay(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth()).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
module.exports = { isoDay };
