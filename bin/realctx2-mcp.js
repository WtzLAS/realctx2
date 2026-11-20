#!/usr/bin/env node
// realctx2's MCP server for Claude Code (design §4.6.1): agent tools + engine host.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { entryFile, run } = createRequire(import.meta.url)("./run-entry.cjs");
const file = entryFile(join(dirname(fileURLToPath(import.meta.url)), ".."), "adapters/claude-code/server");
if (!file) {
  process.stderr.write("realctx2: neither dist/ nor src/ holds the MCP server.\n");
  process.exit(1);
}
run(file, process.argv.slice(2));
