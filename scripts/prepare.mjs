#!/usr/bin/env node
// `npm install` in a checkout builds dist/ when the TypeScript compiler is there. Installs that
// leave dev dependencies out (pi installs git sources with --omit=dev) keep the dist/ they came with.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) {
  if (!existsSync(join(root, "dist", "index.js"))) console.warn("realctx2: dist/ is missing and TypeScript is not installed. Run `npm install && npm run build` in a full checkout.");
  process.exit(0);
}
const run = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" }).status ?? 1;
const built = run([tsc, "-p", "tsconfig.build.json"]);
process.exit(built !== 0 ? built : run([join(root, "scripts", "gen-skills.mjs")]));
