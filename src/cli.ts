#!/usr/bin/env node

import { runWorkerCli } from "./worker/cli.js";

const args = process.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
  console.log("0.1.0");
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
