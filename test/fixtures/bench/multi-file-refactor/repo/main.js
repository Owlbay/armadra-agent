"use strict";

const { fetchUser } = require("./src/users.js");
const { profileLine } = require("./src/profile.js");
const { team } = require("./src/team.js");

console.log(profileLine(1));
console.log(team([2, 3]));
console.log(fetchUser(3).name.toUpperCase());
