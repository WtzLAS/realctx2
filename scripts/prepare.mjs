#!/usr/bin/env node
// `npm install` in a checkout builds dist/ when the TypeScript compiler is there. Installs that
// leave dev dependencies out (pi installs git sources with --omit=dev) skip the build: pi loads
// the extension from src/, and the launchers in bin/ run src/ when there is no dist/.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) process.exit(0);
const run = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" }).status ?? 1;
const built = run([tsc, "-p", "tsconfig.build.json"]);
process.exit(built !== 0 ? built : run([join(root, "scripts", "gen-skills.mjs")]));
