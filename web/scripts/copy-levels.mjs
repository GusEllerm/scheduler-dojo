#!/usr/bin/env node
// Copy the repo-root levels/ (JSON + reference katas) into web/public/levels for a static build.
// Dev serves them via vite middleware; a Pages build needs them as static assets under public/.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, "../../levels");
const to = path.resolve(here, "../public/levels");

if (!existsSync(from)) {
  console.error(`copy-levels: no levels dir at ${from}`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copy-levels: ${from} -> ${to}`);
