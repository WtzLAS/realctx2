#!/usr/bin/env node
// The model-free maintenance worker (design §6.6.8). Started detached at session end.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { entryFile, run } = createRequire(import.meta.url)("./run-entry.cjs");
const file = entryFile(join(dirname(fileURLToPath(import.meta.url)), ".."), "worker/main");
if (!file) process.exit(1);
run(file, process.argv.slice(2));
