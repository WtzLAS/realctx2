/*
 * Shared by the realctx2 launchers. Runs an entry point from `dist/` when the package was built,
 * else straight from `src/` (a git checkout, as `pi install https://github.com/…` makes one).
 * The sources use only erasable TypeScript syntax, so Bun runs them as they are, and Node does
 * with type stripping: on by default since Node 22.18, behind a flag from 22.6.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

/** `dist/<rel>.js`, else `src/<rel>.ts`, under the package root `root`; null when neither exists. */
function entryFile(root, rel) {
  const built = path.join(root, "dist", `${rel}.js`);
  if (fs.existsSync(built)) return built;
  const source = path.join(root, "src", `${rel}.ts`);
  return fs.existsSync(source) ? source : null;
}

/** Can this runtime import `.ts` files without a flag? */
function stripsTypes() {
  if (process.versions.bun) return true;
  return Boolean(process.features && process.features.typescript);
}

/**
 * Import `file` and call its `main(argv)`, then exit with its code. A `.ts` file on a Node that
 * strips types only behind a flag re-runs this script with the flag.
 */
function run(file, argv) {
  if (file.endsWith(".ts") && !stripsTypes()) {
    if (process.env.REALCTX2_STRIP_TYPES === "1") {
      process.stderr.write(`realctx2: this Node (${process.version}) cannot run TypeScript sources. Use Node 22.18 or later, or build the package (npm run build).\n`);
      process.exit(1);
    }
    const res = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ...process.execArgv, process.argv[1], ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, REALCTX2_STRIP_TYPES: "1" } });
    process.exit(res.status === null ? 1 : res.status);
  }
  import(pathToFileURL(file).href)
    .then((m) => m.main(argv))
    .then((code) => process.exit(typeof code === "number" ? code : 0))
    .catch((e) => {
      process.stderr.write(`realctx2: ${String((e && e.stack) || e)}\n`);
      process.exit(1);
    });
}

module.exports = { entryFile, run };
