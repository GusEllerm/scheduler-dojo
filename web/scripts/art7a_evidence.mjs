// Art 7a acceptance evidence (endless campus, review screen, best scores).
//
//   npm run build && npm run preview        # :4173
//   node scripts/art7a_evidence.mjs                      # all three cases
//   node scripts/art7a_evidence.mjs --case endless       # one case
//
// Cases:
//   endless   a save with prefs.endlessUnlocked clicks the Endless chip; the run is watched live
//             at 1x (the endless campus paces at 3,600 sim-s/s — one sim day is 24 s wall);
//             on-campus counts + fps are logged at week 1 and week 2, and
//             art7a-endless-w2.png shows the thicker week. (The scene's vehicle LIST is the whole
//             pre-materialized 30-day stream — 1861 vehicles at t=0 — so density is measured by
//             the ON-CAMPUS count, never by the list length.)
//   overflow  the same endless run, PAUSED immediately (deterministic jumps drive; a pre-frame
//             pause also guarantees the loop never races the seeks) and fast-forwarded with
//             step_until jumps (seekRender, the visual harness's own hook) until a patience ring
//             overflows (~t=1,905,852 s at the default seed — engine-verified; done fires on the
//             stop frame since 4cab6b3): the overflow flash, then the review panel — mistakes
//             non-empty, best persisted, chip shows the best.
//   city      a city (level3) campus run to the end of its horizon: the freeze offers, one is
//             taken, and the SAME review opens with the share bars.
//
// Review-pass note: an earlier "seek stall" investigation was TWO artifacts, not an app race —
// (1) playwright silently does NOT invoke block/expression-bodied `async (t) => …` STRINGS
// passed to evaluate (it returns undefined) — the first passes' "frozen" seeks never ran; every
// seek here is a real function. (2) the real pin was the engine's horizon clamp, fixed in
// 4cab6b3 (stepped runs END at t0+horizon; snapshots publish `horizon_end`). See
// Sessions/2026-10-02 Phase 2 Art 7.md.
//
// The driver clicks in-game buttons (Endless chip, offers, speed select) and only the public
// debug hooks the harness already uses (`__campus.fps()`, `__campus.seekRender()`).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const base = arg("url", "http://127.0.0.1:4173");
const only = arg("case", "all");
const shotDir = resolve(import.meta.dirname, "../../docs/screenshots/campus");
mkdirSync(shotDir, { recursive: true });

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok: ${msg}`);
const say = (msg) => console.log(`    ${msg}`);

/** A save stamped into localStorage before the app's first line (mode=campus boots the campus). */
async function bootApp(page, prefs) {
  await page.addInitScript((doc) => {
    localStorage.setItem("scheduler-dojo:v1", JSON.stringify(doc));
  }, { version: 1, progress: {}, prefs: { mode: "campus", ...prefs } });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForFunction("!document.getElementById('app').hidden", null,
    { timeout: 120_000 });
  await page.waitForSelector(".campus-canvas", { timeout: 30_000 });
}

/** Scene facts through the harness's public hook (never touching privates' semantics). */
const sceneStats = (page) => page.evaluate(`(() => {
  const s = window.__campus?.currentScene();
  if (!s) return null;
  const on = s.vehicles.filter((v) => ["queued", "chosen", "reserved", "running"]
    .includes(v.state)).length;
  return { day: s.day, week: s.week, now: s.now, on, vehicles: s.vehicles.length,
           done: s.done };
})()`);

/** Click a visible button whose text starts with `text`, inside `sel`. */
async function clickButton(page, text, sel = "button") {
  const clicked = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}) && !x.disabled
        && !x.hidden && x.getClientRects().length);
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) fail(`button "${text}" not clickable`);
  return clicked;
}

/**
 * Boot to a running endless campus. The marker is the stream itself: `endless_level`
 * materializes the whole 30-day job list at t=0, so the vehicle list jumps to >1000 the moment
 * the ENDLESS campus exists (a leftover city campus has far fewer) — a `day >= 1` wait is
 * vacuous (the counter starts at 1) and can resolve on the pre-chip campus mid-teardown.
 * `pauseFirst` clicks Pause in the SAME evaluate that observes the marker, before the loop's
 * first `step_until` lands: the run is then driven purely by the seeks below (no wall-clock
 * traffic while the case inspects it). Pausing before the first frame is belt-and-braces
 * determinism, not a workaround — the old "stall" was the evaluate-string artifact + the engine
 * horizon pin, both dead (see the header note).
 */
async function bootEndless(page, prefs = { endlessUnlocked: true }, pauseFirst = false) {
  await bootApp(page, prefs);
  const chip = page.locator(".campus-endless-chip");
  await chip.waitFor();
  const label = (await chip.textContent()) ?? "";
  if (label.includes("locked")) fail(`endless chip still locked: "${label}"`);
  ok(`endless chip live: "${label.trim()}"`);
  await chip.click();
  if (!pauseFirst) {
    await page.waitForFunction("window.__campus?.currentScene()?.vehicles.length > 1000", null,
      { timeout: 90_000 });
    return;
  }
  const st = await page.waitForFunction(`(() => {
    const s = window.__campus?.currentScene();
    if (!s || s.vehicles.length <= 1000) return false;
    const b = [...document.querySelectorAll(".campus-controls button")]
      .find((x) => x.textContent.trim().startsWith("Pause"));
    b?.click();
    return { snap: window.__campus.snap?.now, paused: window.__campus.paused };
  })()`, null, { timeout: 90_000 });
  const stv = await st.jsonValue();
  say(`endless up, paused before the first live step at t=${stv.snap} (paused=${stv.paused})`);
}

/** Deterministic jump via the harness's own hook, returning the engine's own `done` (the
 *  run-over signal — never a day-count guess). The settle-retry loop is belt-and-braces only:
 *  with the horizon fix (4cab6b3) and real-function evaluates it should never fire, and if a
 *  retry DOES happen the log says so loudly. */
async function seekLogged(page, t) {
  for (let attempt = 0; attempt <= 8; attempt++) {
    const r = await page.evaluate(async (t) => {
      try { await window.__campus.seekRender(t); }
      catch (e) { return { err: String((e && e.message) || e) }; }
      return { snap: window.__campus.snap?.now, done: window.__campus.snap?.done };
    }, t);
    if (r.err) {
      // `run_until` after the run ended raises — reaching that is a DONE, not a failure.
      if (/finished/i.test(r.err)) return { done: true, retries: attempt };
      fail(`seek(${t}) errored: ${r.err}`);
      return { done: false, retries: attempt };
    }
    if (r.done || (r.snap ?? 0) >= t) return { ...r, retries: attempt };
    if (attempt === 0) say(`unexpected seek stall (retrying): snap ${r.snap} < target ${t}, done=${r.done}`);
    await page.waitForTimeout(400);
  }
  fail(`seek(${t}) never advanced`);
  return { done: false, retries: 8 };
}

// --- (a) endless, live at 1x: week 1 vs week 2 + fps ------------------------------------------

async function caseEndless(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await bootEndless(page, { endlessUnlocked: true }, false);   // LIVE: the rAF loop drives
  // wait for a settled week-1 sample (day 2+ = ~48 s wall at the 3,600 sim-s/s endless pace)
  await page.waitForFunction(
    "(() => { const s = window.__campus?.currentScene(); return s && s.day >= 2; })()",
    null, { timeout: 240_000 });
  const w1 = await sceneStats(page);
  say(`week ${w1.week} · day ${w1.day} · on campus ${w1.on} · stream size ${w1.vehicles} `
    + `(constant: the whole 30-day stream exists at t=0)`);
  const fps = [];
  // The default seed's ramp, honestly: the 4-bay lot absorbs weeks 1–2, and the jam that kills
  // the run (~day 22) builds from ~day 16. So the screenshot's wait is DENSITY-DRIVEN (the run's
  // own signal — on-campus >= 6 — not a day count): it captures the thickening whenever it
  // actually arrives, at week >= 2 (asserted).
  await page.waitForFunction(
    "(() => { const s = window.__campus?.currentScene(); return s && s.day >= 8; })()",
    null, { timeout: 420_000 });
  const w2 = await sceneStats(page);
  say(`week ${w2.week} · day ${w2.day} · on campus ${w2.on}`);
  await page.waitForFunction(`(() => {
    const s = window.__campus?.currentScene();
    if (!s) return false;
    const on = s.vehicles.filter((v) => ["queued", "chosen", "reserved", "running"]
      .includes(v.state)).length;
    return on >= 6 || s.done === true;
  })()`, null, { timeout: 900_000 });
  const w2b0 = await sceneStats(page);
  if (w2b0.week < 2) fail(`week >= 2 expected at the shot, scene says week ${w2b0.week}`);
  await page.screenshot({ path: `${shotDir}/art7a-endless-w2.png` });
  for (let i = 0; i < 6; i++) {
    fps.push(await page.evaluate("window.__campus?.fps() ?? 0"));
    await page.waitForTimeout(500);
  }
  // Peak on-campus density over a short window — an INSTANTANEOUS count can dip between
  // arrivals, and a dip would say "thinner" about a week that is demonstrably thicker.
  let peak = w2b0.on;
  let w2b = w2b0;
  for (let i = 0; i < 8; i++) {
    const s = await sceneStats(page);
    if (s.on > peak) { peak = s.on; w2b = s; }
    await page.waitForTimeout(400);
  }
  say(`week ${w2b.week} · day ${w2b.day} · on campus ${w2b.on} (window peak ${peak}) `
    + `· stream size ${w2b.vehicles}`);
  say(`fps samples: ${fps.map((f) => f.toFixed(0)).join(", ")}`);
  if (!fps.some((f) => f >= 45)) fail(`fps never reached 45: ${fps.join(", ")}`);
  if (peak <= w1.on) fail(`on-campus traffic not denser by the shot (${w1.on} -> peak ${peak})`);
  ok(`week 1 on-campus ${w1.on} -> week 2 on-campus ${w2b.on} (peak ${peak}), `
    + `fps peak ${Math.max(...fps).toFixed(0)}`);
  await page.close();
}

// --- (b) fast-forward to overflow -> review ----------------------------------------------------

async function caseOverflow(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await bootEndless(page, { endlessUnlocked: true }, true);    // paused before the first frame
  const bestBefore = await page.evaluate(
    `JSON.parse(localStorage.getItem("scheduler-dojo:v1")).prefs.endlessBest ?? null`);
  say(`prefs.endlessBest BEFORE the run: ${JSON.stringify(bestBefore)}`);
  let jumped = 0;
  let retries = 0;
  // The default seed overflows at t=1,905,852 (day 22.05, user4) — engine-verified — so 3-day
  // jumps must pass it by day 23; the +2-step overrun also covers a horizon end (done may only
  // surface once a step is asked to go PAST the horizon).
  for (let t = 5 * 86_400; t <= 33 * 86_400; t += 3 * 86_400) {
    const r = await seekLogged(page, t);
    jumped = t;
    retries += r.retries;
    if (r.done) break;
  }
  if (retries) say(`WARNING: ${retries} seek retries needed (expected 0) — investigate`);
  const end = await page.evaluate(`(async () => {
    await new Promise((r) => setTimeout(r, 1200));   // the overflow flash's hold (~900 ms)
    const s = window.__campus.snap ?? {};
    return { now: s.now, done: s.done, overflow: s.overflow ?? "" };
  })()`);
  say(`fast-forwarded to t=${end.now} (${(end.now / 86_400).toFixed(2)} days), ` 
    + `done=${end.done}, overflow='${end.overflow}' (last jump target ${jumped})`);
  if (!end.done) fail("the endless run did not end within the jump budget");
  if (!end.overflow) fail("the endless run ended without a patience overflow");
  await page.waitForSelector(".review-panel", { timeout: 20_000 });
  const facts = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll(".review-mistakes li")]
      .map((li) => li.textContent.trim());
    const bars = document.querySelectorAll(".review-panel .campus-fairness-list li").length;
    const best = JSON.parse(localStorage.getItem("scheduler-dojo:v1")).prefs.endlessBest ?? null;
    const line = document.querySelector(".review-endless")?.textContent ?? "";
    const strip = !!document.querySelector(".review-strip canvas");
    const chip = document.querySelector(".campus-endless-chip")?.textContent.trim() ?? "";
    const overflowed = rows.some((r) => /patience ring filled/.test(r));
    const timeouts = rows.some((r) => /timed out|without ever finding bays/.test(r));
    return { rows, bars, best, line, strip, chip, overflowed, timeouts };
  })()`);
  for (const r of facts.rows.slice(0, 8)) say(`mistake: ${r}`);
  if (!facts.rows.length) fail("review mistakes list is empty");
  if (!facts.overflowed) fail("no overflow line in the mistakes list");
  if (!facts.timeouts) fail("no timeouts / never-parked lines in the mistakes list");
  if (!facts.strip) fail("the review strip (timeline) did not mount");
  if (!facts.bars) fail("no fairness share rows in the review");
  if (!facts.best || typeof facts.best.days !== "number") fail("prefs.endlessBest not persisted");
  else ok(`prefs.endlessBest AFTER the run: ${JSON.stringify(facts.best)} ` 
    + `(before: ${JSON.stringify(bestBefore ?? null)})`);
  if (!/best/i.test(facts.line)) fail(`review lacks the best line: "${facts.line}"`);
  if (!/best/i.test(facts.chip)) fail(`chip does not show the best: "${facts.chip}"`);
  say(`review line: ${facts.line}`);
  ok(`review open: ${facts.rows.length} mistake lines, ${facts.bars} fairness rows`);
  await page.screenshot({ path: `${shotDir}/art7a-review.png` });
  await page.close();
}

// --- (c) a city run to the end of its horizon -> review with the bars --------------------------

async function caseCity(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await bootApp(page, { level: "level3" });   // no endlessUnlocked: the chip must read locked
  const chip = page.locator(".campus-endless-chip");
  const locked = (await chip.textContent())?.includes("locked");
  if (!locked) fail("endless chip should read locked without the unlock");
  else ok("endless chip locked without endlessUnlocked");
  await page.selectOption(".campus-controls select", "8");
  await page.waitForSelector(".offers-panel", { timeout: 180_000 });   // the horizon freeze
  ok("week boundary frozen at the horizon — offers up");
  await page.locator(".offers-panel .offer-card button").first().click();
  await page.waitForSelector(".review-panel", { timeout: 60_000 });
  const facts = await page.evaluate(`(() => {
    const bars = document.querySelectorAll(".review-panel .campus-fairness-list li").length;
    const strip = !!document.querySelector(".review-strip canvas");
    const stats = [...document.querySelectorAll(".review-stats .stat b")]
      .map((b) => b.textContent);
    const mis = [...document.querySelectorAll(".review-mistakes li, .review-mistakes .review-ok")]
      .map((li) => li.textContent.trim());
    return { bars, strip, stats, mis };
  })()`);
  say(`stats: ${facts.stats.join(" · ")}`);
  for (const r of facts.mis.slice(0, 6)) say(`note: ${r}`);
  if (!facts.bars) fail("city review shows no fairness share bars");
  if (!facts.strip) fail("city review strip (timeline) did not mount");
  ok(`city review: ${facts.bars} fairness bars, strip mounted`);
  await page.screenshot({ path: `${shotDir}/art7a-review-city.png` });
  await page.close();
}

const browser = await chromium.launch();
try {
  if (only === "all" || only === "endless") await caseEndless(browser);
  if (only === "all" || only === "overflow") await caseOverflow(browser);
  if (only === "all" || only === "city") await caseCity(browser);
} finally {
  await browser.close();
}
console.log(process.exitCode ? "art7a evidence: FAILED" : "art7a evidence: ok");
