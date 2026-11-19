#!/usr/bin/env node
// The model-free maintenance worker (design §6.6.8). Started detached at session end.
import("../dist/worker/main.js")
  .then((m) => m.main(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch(() => process.exit(1));
