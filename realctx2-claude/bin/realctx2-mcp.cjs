#!/usr/bin/env node
/*
 * Starts realctx2's MCP server (the engine host of a Claude Code session, design §4.6.1).
 * The plugin directory ships inside the realctx2 npm package; when it was copied elsewhere,
 * the package is looked up through REALCTX2_PACKAGE, the plugin's data directory, or the
 * global module directories. A marketplace install copies only the plugin directory: when no
 * package is found, the first run installs one into the plugin's data directory
 * (realctx2-install.cjs) and waits for it as long as Claude Code's MCP startup timeout allows.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dataDir = process.env.CLAUDE_PLUGIN_DATA;
const version = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch (_) {
    return null;
  }
})();

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
  if (dataDir && version) out.push(path.join(dataDir, "runtime", version, "realctx2"));
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
const findRoot = () => candidates().find((dir) => fs.existsSync(path.join(dir, "bin", "run-entry.cjs")) && (fs.existsSync(path.join(dir, "dist", "adapters", "claude-code", "server.js")) || fs.existsSync(path.join(dir, "src", "adapters", "claude-code", "server.ts"))));

function start(root) {
  const { entryFile, run } = require(path.join(root, "bin", "run-entry.cjs"));
  run(entryFile(root, "adapters/claude-code/server"), process.argv.slice(2));
}

function fail(msg) {
  process.stderr.write(`realctx2: ${msg}\n`);
  process.exit(1);
}

/** Install the package into the plugin's data directory, in the background, and start it when it is there. */
function firstRun() {
  const installer = path.join(__dirname, "realctx2-install.cjs");
  const log = require(installer).logFile(dataDir, version);
  process.stderr.write(`realctx2: first run: installing the realctx2 package ${version} into ${dataDir} (log: ${log})\n`);
  const child = spawn(process.execPath, [installer, dataDir, version], { detached: true, stdio: "ignore", windowsHide: true });
  const waitMs = Math.max(5000, (Number(process.env.MCP_TIMEOUT) || 30000) - 5000);
  const timer = setTimeout(() => {
    child.unref();
    fail(`the install is still running (log: ${log}). When it is done, reconnect realctx2 in /mcp or start a new session.`);
  }, waitMs);
  child.on("error", (e) => {
    clearTimeout(timer);
    fail(`cannot run the installer: ${e.message}`);
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    const root = findRoot();
    if (root) start(root);
    else fail(`the install failed (exit ${code}); see ${log}. Or install the package yourself and set REALCTX2_PACKAGE.`);
  });
}

const root = findRoot();
if (root) start(root);
else if (dataDir && version) firstRun();
else fail("cannot find the realctx2 package (dist/ or src/adapters/claude-code/server). Install it, or set REALCTX2_PACKAGE.");
