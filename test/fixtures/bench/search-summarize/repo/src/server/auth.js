"use strict";

// The secret is never logged.
const secret = process.env.SESSION_SECRET;

function sign(payload) {
  return `${payload}.${secret ? secret.length : 0}`;
}

module.exports = { sign };
