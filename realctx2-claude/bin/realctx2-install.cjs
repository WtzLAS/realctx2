#!/usr/bin/env node
/*
 * First-run install of the realctx2 package, for a plugin that Claude Code installed from a
 * marketplace: that copy holds only realctx2-claude/, not the package around it. The MCP
 * launcher (realctx2-mcp.cjs) runs this in a process group of its own, so an install that
 * outlasts Claude Code's MCP startup timeout still completes.
 *
 *   realctx2-install <dataDir> <version>       dataDir is the plugin's CLAUDE_PLUGIN_DATA
 *
 * The package is unpacked to <dataDir>/runtime/<version>/realctx2, and its runtime dependencies
 * are installed next to it, in <dataDir>/runtime/<version>/node_modules. The package itself
 * stays out of node_modules: a GitHub tarball has the TypeScript sources and no dist/, and
 * Node strips types only outside node_modules.
 *
 * The source is the GitHub tarball of the tag v<version>, else of main when main is at
 * <version>. REALCTX2_PACKAGE_SOURCE names another .tar.gz (URL or file). Only Node built-ins
 * are used, plus npm (Bun, when this runs under Bun) for the dependencies. Progress and
 * errors go to <dataDir>/runtime/install-<version>.log.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");

const REPO = "WtzLAS/realctx2";
const DEADLINE_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const DEPS_TIMEOUT_MS = 5 * 60 * 1000;

const runtimeDir = (dataDir) => path.join(dataDir, "runtime");
const logFile = (dataDir, version) => path.join(runtimeDir(dataDir), `install-${version}.log`);

/** The package root that a completed install of `version` left in `dataDir`; null before. */
function installedRoot(dataDir, version) {
  const root = path.join(runtimeDir(dataDir), version, "realctx2");
  return fs.existsSync(path.join(root, "bin", "run-entry.cjs")) ? root : null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Take the install lock (a directory); a lock whose holder died, or that is old, is broken. */
function acquire(lock) {
  try {
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let stale = false;
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
    } catch (_) {
      // its holder has not written the pid yet
    }
    stale = age > LOCK_STALE_MS || (pid > 0 ? !alive(pid) : age > 30000);
  } catch (_) {
    return false; // released meanwhile; the caller tries again
  }
  if (stale) fs.rmSync(lock, { recursive: true, force: true });
  return false;
}

function parsePax(body) {
  const out = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const len = sp < 0 ? 0 : Number(body.toString("latin1", i, sp));
    if (!len) break;
    const rec = body.toString("utf8", sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Unpack the .tar.gz `gz` into `dest`, without its first path component (GitHub and npm
 * tarballs put everything in one directory). Files and directories only; links are skipped.
 */
function untar(gz, dest) {
  const buf = zlib.gunzipSync(gz);
  const str = (b) => {
    const end = b.indexOf(0);
    return b.toString("utf8", 0, end < 0 ? b.length : end);
  };
  let off = 0;
  let pax = null;
  let longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = parsePax(body);
      continue;
    }
    if (type === "L") {
      longName = str(body);
      continue;
    }
    if (type === "g") continue;
    let name = str(h.subarray(0, 100));
    if (h.toString("latin1", 257, 263) === "ustar\0") {
      const prefix = str(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    name = (pax && pax.path) || longName || name;
    pax = null;
    longName = null;
    const parts = name.split("/").filter(Boolean).slice(1);
    if (!parts.length) continue;
    if (parts.some((p) => p === "." || p === ".." || /[\\:]/.test(p))) throw new Error(`unsafe path in the archive: ${name}`);
    const out = path.join(dest, ...parts);
    if (type === "5") fs.mkdirSync(out, { recursive: true });
    else if (type === "0" || type === "7") {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const mode = parseInt(str(h.subarray(100, 108)).trim() || "644", 8);
      fs.writeFileSync(out, body, { mode: (mode & 0o777) | 0o600 });
    }
  }
}

async function download(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw Object.assign(new Error(`${source}: HTTP ${res.status}`), { status: res.status });
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(source.startsWith("file:") ? fileURLToPath(source) : source);
}

/** The package tarball for `version`: { from, tgz, exact } (exact: it was asked for by name). */
async function fetchPackage(version, log) {
  const override = process.env.REALCTX2_PACKAGE_SOURCE;
  if (override) return { from: override, tgz: await download(override), exact: true };
  for (const ref of [`refs/tags/v${version}`, "refs/heads/main"]) {
    const url = `https://codeload.github.com/${REPO}/tar.gz/${ref}`;
    try {
      return { from: url, tgz: await download(url), exact: ref.startsWith("refs/tags/") };
    } catch (e) {
      if (e.status !== 404) throw e;
      log(`${url}: not found`);
    }
  }
  throw new Error(`neither the tag v${version} nor main was found in github.com/${REPO}`);
}

/** How to run `install` with the package manager that goes with this runtime. */
function packageManager() {
  if (process.versions.bun) return { cmd: process.execPath, args: ["install", "--production", "--no-save", "--ignore-scripts"] };
  const args = ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", "--loglevel=warn"];
  const dir = path.dirname(process.execPath);
  for (const cli of [path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli, ...args] };
  }
  return process.platform === "win32" ? { cmd: "npm.cmd", args, shell: true } : { cmd: "npm", args };
}

async function installOnce(base, version, logFd, log) {
  for (const f of fs.readdirSync(base)) if (f.startsWith(`.stage-${version}-`)) fs.rmSync(path.join(base, f), { recursive: true, force: true });
  const stage = fs.mkdtempSync(path.join(base, `.stage-${version}-`));
  try {
    const { from, tgz, exact } = await fetchPackage(version, log);
    log(`unpacking ${from} (${tgz.length} bytes)`);
    const root = path.join(stage, "realctx2");
    untar(tgz, root);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (pkg.name !== "realctx2") throw new Error(`${from} is not the realctx2 package (name: ${pkg.name})`);
    if (pkg.version !== version) {
      if (!exact) throw new Error(`main is at realctx2 ${pkg.version}, not ${version}, and there is no tag v${version}`);
      log(`note: ${from} is realctx2 ${pkg.version}, the plugin is ${version}`);
    }
    if (!fs.existsSync(path.join(root, "bin", "run-entry.cjs"))) throw new Error(`${from} has no bin/run-entry.cjs`);
    // The dependencies go next to the package, where Node resolves them from its sources.
    fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({ name: "realctx2-runtime", private: true, dependencies: pkg.dependencies || {} }, null, 2)}\n`);
    const pm = packageManager();
    log(`installing ${Object.keys(pkg.dependencies || {}).join(", ")}: ${pm.cmd} ${pm.args.join(" ")}`);
    const res = spawnSync(pm.cmd, pm.args, { cwd: stage, stdio: ["ignore", logFd, logFd], shell: pm.shell, windowsHide: true, timeout: DEPS_TIMEOUT_MS });
    if (res.status !== 0) throw new Error(`the dependency install failed (${res.error ? res.error.message : res.signal || `exit ${res.status}`})`);
    const final = path.join(base, version);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(stage, final);
    log(`installed realctx2 ${pkg.version} in ${final}`);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

/** Install realctx2 `version` into `dataDir` unless it is there; waits out a concurrent install. */
async function install(dataDir, version) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version || "")) throw new Error(`bad plugin version: ${version}`);
  const base = runtimeDir(dataDir);
  fs.mkdirSync(base, { recursive: true });
  const logFd = fs.openSync(logFile(dataDir, version), "a");
  const log = (msg) => fs.writeSync(logFd, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  const lock = path.join(base, `.lock-${version}`);
  const deadline = Date.now() + DEADLINE_MS;
  try {
    while (!installedRoot(dataDir, version)) {
      if (acquire(lock)) {
        try {
          if (!installedRoot(dataDir, version)) await installOnce(base, version, logFd, log);
        } finally {
          fs.rmSync(lock, { recursive: true, force: true });
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for another install");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (e) {
    log(`failed: ${e.message}`);
    throw e;
  } finally {
    fs.closeSync(logFd);
  }
}

module.exports = { install, installedRoot, logFile };

if (require.main === module) {
  const [dataDir, version] = process.argv.slice(2);
  install(dataDir, version).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`realctx2: ${e.message}\n`);
      process.exit(1);
    },
  );
}
