"use strict";

const USERS = { 1: "ada", 2: "linus", 3: "grace" };

function fetchUser(id) {
  const name = USERS[id];
  if (!name) throw new Error(`unknown user ${id}`);
  return { id, name };
}

module.exports = { fetchUser };
