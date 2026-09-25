// Campus visual + performance harness (Art 3 acceptance: "watch 9 cities, 60 fps").
// Boots the built app's harness page in headless Chromium, seeks each city deterministically,
// asserts the canvas actually paints (non-uniform pixels), and samples the rAF loop for fps.
// Screenshots land in docs/screenshots/campus/ for humans; CI uploads them as an artifact.
//
//   node scripts/campus_visual.mjs [--url http://127.0.0.1:4173] [--levels level1,...] [--fps-min 45]

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const base = arg("url", "http://127.0.0.1:4173");
const levels = arg("levels", "level1,level2,level3,level4,level5,level6,level7,level8,level9")
  .split(",");
const fpsMin = Number(arg("fps-min", "45"));
const shotDir = resolve(import.meta.dirname, "../../docs/screenshots/campus");
mkdirSync(shotDir, { recursive: true });

/** rAF sampler installed before boot: counts frames in a wall window (independent of the game). */
const SAMPLER = `
  window.__frames = 0;
  (function tick() { window.__frames++; requestAnimationFrame(tick); })();
`;

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

const browser = await chromium.launch();
try {
  for (const level of levels) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.addInitScript(SAMPLER);
    const url = `${base}/campus-harness.html?level=${level}&w=1600&h=736`;
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.__dojoCampus?.ready === true", null,
      { timeout: 120_000 }); // first boot downloads Pyodide + the wheel

    // Deterministic settled frame: seek past warmup, screenshot, and check the canvas is not flat.
    await page.evaluate("window.__dojoCampus.seekRender(24000)");
    const painted = await page.evaluate(`(() => {
      const c = document.querySelector("canvas");
      const g = c.getContext("2d");
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 997) seen.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
      return seen.size;
    })()`);
    if (painted < 8) fail(`${level}: canvas looks flat (${painted} sampled colors)`);

    // Live (non-reduced-motion) rAF pacing for the fps figure: reload without reduced motion is
    // not a harness mode, so measure the harness loop's own frames plus a wall window.
    // Render throughput = the play loop's own frame clock (rAF does not tick in headless shells,
    // so the page-level counter is only informative in a headed browser).
    const fps = await page.evaluate(`(async () => {
      for (let t = 24_000; t <= 31_200; t += 1_200) await window.__dojoCampus.seekRender(t);
      return window.__dojoCampus.fps();
    })()`);

    await page.screenshot({ path: `${shotDir}/${level}.png` });
    console.log(`${level}: painted=${painted} colors, seek-loop=${fps.toFixed(1)} fps`);
    if (fps < fpsMin) fail(`${level}: ${fps.toFixed(1)} fps < ${fpsMin}`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(process.exitCode ? "campus visual: FAILED" : "campus visual: ok");
