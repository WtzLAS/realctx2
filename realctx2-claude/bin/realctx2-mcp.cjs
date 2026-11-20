#!/usr/bin/env node
/*
 * Starts realctx2's MCP server (the engine host of a Claude Code session, design §4.6.1).
 * The plugin directory ships inside the realctx2 npm package; when it was copied elsewhere,
 * the package is looked up through REALCTX2_PACKAGE or the global module directories.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function candidates() {
  const out = [];
  if (process.env.REALCTX2_PACKAGE) out.push(process.env.REALCTX2_PACKAGE);
  let here = __dirname;
  try {
    here = fs.realpathSync(__dirname);
  } catch (_) {
    // keep the lexical path
  }
  out.push(path.resolve(here, "..", ".."));
  try {
    out.push(path.dirname(require.resolve("realctx2/package.json")));
  } catch (_) {
    // not resolvable from here
  }
  const exec = path.dirname(process.execPath);
  out.push(path.resolve(exec, "..", "lib", "node_modules", "realctx2"), path.resolve(exec, "node_modules", "realctx2"));
  for (const dir of (process.env.NODE_PATH || "").split(path.delimiter)) if (dir) out.push(path.join(dir, "realctx2"));
  return out;
}

// a built package, or a git checkout run from its sources
const root = candidates().find((dir) => fs.existsSync(path.join(dir, "bin", "run-entry.cjs")) && (fs.existsSync(path.join(dir, "dist", "adapters", "claude-code", "server.js")) || fs.existsSync(path.join(dir, "src", "adapters", "claude-code", "server.ts"))));
if (!root) {
  process.stderr.write("realctx2: cannot find the realctx2 package (dist/ or src/adapters/claude-code/server). Install it, or set REALCTX2_PACKAGE.\n");
  process.exit(1);
}
const { entryFile, run } = require(path.join(root, "bin", "run-entry.cjs"));
run(entryFile(root, "adapters/claude-code/server"), process.argv.slice(2));
