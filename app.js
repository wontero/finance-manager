const { existsSync } = require("node:fs");
const { basename, join } = require("node:path");
const { loadEnvFile } = require("node:process");

const envFile = join(__dirname, ".env");
if (existsSync(envFile)) loadEnvFile(envFile);

// Passenger loads app.js with require(). The server workspace is ESM.
import("./src/server/dist/serve.js")
  .then(({ start }) => start(basename(__dirname)))
  .catch((error) => {
    console.error(`No se pudo iniciar Finance Manager. ${error.message}`);
    process.exitCode = 1;
  });
