"use strict";

// Note: configuration comes from the environment elsewhere; this file only formats.
function title(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = { title };
