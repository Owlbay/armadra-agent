"use strict";

const days = Number(process.env.RETENTION_DAYS || 30);
const dryRun = process.env.CLEANUP_DRY_RUN === "1";

function plan(files) {
  return files.filter((file) => file.ageDays > days).map((file) => ({ file, dryRun }));
}

module.exports = { plan };
