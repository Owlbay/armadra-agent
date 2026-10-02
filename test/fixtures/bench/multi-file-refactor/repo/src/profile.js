"use strict";

const { fetchUser } = require("./users.js");

function profileLine(id) {
  const user = fetchUser(id);
  return `#${user.id} ${user.name}`;
}

module.exports = { profileLine };
