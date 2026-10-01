#!/usr/bin/env node

import { runWorkerCli } from "./worker/cli.js";
import { CLOUD_VERSION } from "./version.js";

const args = process.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
  console.log(CLOUD_VERSION);
} else {
  runWorkerCli(args)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
