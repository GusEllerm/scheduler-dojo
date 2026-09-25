// WCAG contrast gate for web/tokens/palette.json (Concepts/Art Direction.md).
// Run from web/: node scripts/check_contrast.mjs   — nonzero exit if any pair fails.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pal = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "tokens/palette.json"), "utf8")
);

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => lin(x / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

let bad = 0;
for (const theme of Object.keys(pal.themes)) {
  const t = pal.themes[theme];
  console.log(`\n[${theme}]`);
  for (const p of pal.contrast_pairs) {
    const r = ratio(t[p.fg], t[p.bg]);
    const ok = r >= p.min;
    if (!ok) bad++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${r.toFixed(2).padStart(5)} (≥${p.min})  ${p.fg} on ${p.bg} — ${p.why}`
    );
  }
}
process.exit(bad ? 1 : 0);
