"use strict";

const port = Number(process.env.PORT ?? 8080);

function listen(app) {
  return app.listen(port);
}

module.exports = { listen };
