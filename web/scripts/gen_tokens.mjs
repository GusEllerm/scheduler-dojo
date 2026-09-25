// Generate the two token consumers from web/tokens/palette.json — the ONE colour source
// (Concepts/Art Direction.md). Run: node scripts/gen_tokens.mjs   (from web/)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pal = JSON.parse(readFileSync(join(root, "tokens/palette.json"), "utf8"));

const cssVars = (theme) =>
  Object.entries(pal.themes[theme])
    .map(([k, v]) => `  --sd-${k}: ${v};`)
    .join("\n");

writeFileSync(
  join(root, "src/tokens.css"),
  `/* GENERATED from web/tokens/palette.json by scripts/gen_tokens.mjs — do not edit. */\n:root,\n:root[data-theme="light"] {\n${cssVars("light")}\n}\n:root[data-theme="dark"] {\n${cssVars("dark")}\n}\n`
);

const tsRoles = Object.keys(pal.roles);
writeFileSync(
  join(root, "src/tokens.ts"),
  `// GENERATED from web/tokens/palette.json by scripts/gen_tokens.mjs — do not edit.\n` +
  `// Canvas-side color table: read the live CSS custom properties so the campus canvas and the\n` +
  `// DOM share one source (Concepts/Art Direction.md).\n` +
  `export const TOKEN_ROLES = ${JSON.stringify(tsRoles, null, 2)} as const;\n` +
  `export type TokenRole = (typeof TOKEN_ROLES)[number];\n\n` +
  `export function readTokens(getComputedStyleFn = getComputedStyle): Record<string, string> {\n` +
  `  const s = getComputedStyleFn(document.documentElement);\n` +
  `  const out: Record<string, string> = {};\n` +
  `  for (const role of TOKEN_ROLES) out[role] = s.getPropertyValue(\`--sd-\${role}\`).trim();\n` +
  `  return out;\n}\n\n` +
  `export function tokensFromCanvas(getComputedStyleFn = getComputedStyle): Record<string, string> {\n` +
  `  return readTokens(getComputedStyleFn);\n}\n`
);
console.log("wrote src/tokens.css + src/tokens.ts");
