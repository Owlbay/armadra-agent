"use strict";

const users = require("./users.js");

function team(ids) {
  return ids.map((id) => users.fetchUser(id).name).join(", ");
}

module.exports = { team };
