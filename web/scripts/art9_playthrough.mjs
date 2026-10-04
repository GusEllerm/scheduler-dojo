// Art 9 ship evidence: the FINAL PLAYTHROUGH (brief §9 "ship": one fresh save, end to end).
//
//   npm run build && npm run preview            # :4173
//   node scripts/art9_playthrough.mjs           # the whole run (~2-3 min)
//   node scripts/art9_playthrough.mjs --url http://127.0.0.1:5173   # a dev server works too
//
// It plays like a person who has never seen the game and has read nothing: a BROWSER CONTEXT WITH
// NO localStorage at all, one tab, and only clicks/keys a player has. Gates:
//   welcome     the fresh-save welcome card appears, with both doors  -> art9-playthrough.png
//   doors       "Start city 1 ▸" opens the guided hand city (the script is on stage)
//   beats       the city-1 script advances through >= 3 of its own beats (`__tutorial.debugState()`)
//   skip        "Skip tutorial" ends the script and unlocks the campus
//   board       the city board opens with REAL campus frames (per-tile canvas pixel diversity)
//   esc         Escape closes the topmost card
//   watch       a live city run plays to its end and a review is reachable
//   review      the review panel shows the strip + shares                       -> art9-playthrough-review.png
//   mint        the review's Share mints a `#card=` link (engine hash)
//   card-route  the SAME tab gets that hash; the hashchange route re-runs it and the engine says
//               verified (`dojo-share-mint` hash == `dojo-share-replay` got)
//   help        "?" opens the help drawer
//   keyboard    Space pauses the campus clock (the sim clock stops; fps drops), S steps one batch
//
// Prints one gate table (gate/result/detail) + total wall time and exits nonzero on any FAIL.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const base = arg("url", "http://127.0.0.1:4173");
const shotDir = resolve(import.meta.dirname, "../../docs/screenshots/campus");
mkdirSync(shotDir, { recursive: true });
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);

const rows = [];
function gate(name, pass, detail = "") {
  rows.push({ gate: name, result: pass ? "PASS" : "FAIL", detail });
  console.log(`[${elapsed()}s] ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const say = (msg) => console.log(`[${elapsed()}s]         ${msg}`);

/** The player's own hands, installed in the page: dismiss what asks, park what waits, press Time.
 *  Same shape as `art6b_evidence.mjs`'s driver — no private calls, no engine facts invented here. */
const DRIVER = `
window.__drive = async (budgetMs) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
  const btn = (text, sel) => [...document.querySelectorAll(sel || "button")]
    .find((b) => b.textContent.trim().startsWith(text) && !b.disabled && vis(b));
  const stepId = () => window.__tutorial?.debugState?.().stepId ?? "";
  const log = [];
  const beat = stepId();
  if (beat && !log.includes("beat:" + beat)) log.push("beat:" + beat);
  const t = performance.now();
  while (performance.now() - t < budgetMs) {
    const b = stepId();
    if (b && b !== beat) log.push("beat:" + b);
    // (a) any asking card: a tutorial callout (not the week-end offers panel) or the booth
    const callout = q(".callout-panel:not(.offers-panel)");
    if (callout && vis(callout)) {
      callout.querySelector(".callout-actions button")?.click();
      await sleep(150);
      continue;
    }
    const booth = q(".booth-overlay");
    if (booth && vis(booth)) {
      const cards = [...booth.querySelectorAll(".booth-lib-card")];
      for (const slot of ["order", "place"]) {
        const zone = [...booth.querySelectorAll(".booth-slot")]
          .find((z) => z.querySelector(".slot-name")?.textContent.trim() === slot);
        if (!zone || zone.querySelector(".slot-card")?.textContent.trim() !== "empty — tap a card below") continue;
        const card = cards.find((c) => c.querySelector("span")?.textContent.trim() === slot);
        if (!card) continue;
        card.click();
        await sleep(60);
        zone.querySelector(".booth-slot-btn").click();
        await sleep(450);
      }
      booth.querySelector(".booth-close")?.click();
      await sleep(150);
      continue;
    }
    const offer = q(".offers-panel .offer-card button");
    if (offer && vis(offer)) { offer.click(); await sleep(500); continue; }
    // (b) play: park what is on the road, else press Time
    const canvas = q(".campus-canvas");
    if (!canvas) { await sleep(300); continue; }
    const scene = window.__campus?.currentScene?.();
    const key = (k) => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    if ((scene?.queuedOrder ?? []).length) {
      canvas.focus();
      key("ArrowRight");                       // choose the vehicle (engine road order)
      await sleep(90);
      key("Enter");                            // stage its bays …
      await sleep(90);
      key("Enter");                            // … and park (the engine decides)
      await sleep(180);
      continue;
    }
    const time = btn("Time", ".campus-hand-bar button");
    if (time) { time.click(); await sleep(60); continue; }
    await sleep(200);
  }
  return { log, state: window.__tutorial?.debugState?.() ?? null };
};
`;

/** Click a visible button by text prefix (the player's click, not a private call). */
async function clickText(page, text, sel = "button") {
  return page.evaluate(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) =>
      x.textContent.trim().startsWith(${JSON.stringify(text)}) && !x.disabled
      && !x.hidden && x.getClientRects().length);
    if (!b) return false;
    b.click();
    return true;
  })()`);
}

const visible = (page, sel) =>
  page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    return !!e && !e.hidden && e.getClientRects().length > 0; })()`);

const browser = await chromium.launch();
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const mintLines = [];
  const replayLines = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("dojo-share-mint")) mintLines.push(t);
    if (t.startsWith("dojo-share-replay")) replayLines.push(t);
    if (m.type() === "error") say(`[console.error] ${t.slice(0, 160)}`);
  });
  page.on("pageerror", (e) => say(`[pageerror] ${String(e).slice(0, 240)}`));
  // A genuinely fresh save: no addInitScript, so localStorage starts empty (the welcome's trigger).
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForFunction("!document.getElementById('app').hidden", null, { timeout: 240_000 });
  await page.addScriptTag({ content: DRIVER });

  // ---------------------------------------------------------------- welcome card --
  const welcomed = await visible(page, ".welcome-panel");
  const doors = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll(".welcome-panel button")].map((x) => x.textContent.trim());
    return b.filter((t) => /Start city 1|Take a walk/.test(t)).length;
  })()`);
  gate("welcome", welcomed && doors === 2,
    welcomed ? `fresh save, doors=${doors}` : "no welcome card on a fresh save");
  await page.screenshot({ path: `${shotDir}/art9-playthrough.png` });

  // --------------------------------------------------------- door: city 1 (guided) --
  const started = await clickText(page, "Start city 1");
  await page.waitForFunction("!!window.__tutorial && !!window.__campus", null,
    { timeout: 240_000 });
  const boot = await page.evaluate("window.__tutorial.debugState()");
  gate("doors", started && boot.city === 1, `__tutorial.debugState().city=${boot.city}`);

  // ------------------------------------------------------------ >= 3 script beats --
  const beats = new Set();
  const beatsDeadline = Date.now() + 90_000;
  while (Date.now() < beatsDeadline && beats.size < 3) {
    const res = await page.evaluate(async () => await window.__drive(6_000));
    for (const line of res.log) if (line.startsWith("beat:")) beats.add(line.slice(5));
    if (res.state?.stepId) beats.add(res.state.stepId);
  }
  gate("beats", beats.size >= 3, `beats [${[...beats].join(", ")}]`);
  if (beats.size < 3) say(`script state at the cut: ${JSON.stringify(await page.evaluate("window.__tutorial?.debugState() ?? null"))}`);

  // ---------------------------------------------------------------------- skip --
  const skipped = await clickText(page, "Skip tutorial", ".tutorial-skip");
  await page.waitForTimeout(600);
  const skipGone = !(await visible(page, ".tutorial-skip"));
  gate("skip", skipped && skipGone, skipped ? "script ended, campus unlocked" : "no Skip tutorial button");

  // ----------------------------------------------------------------- city board --
  await clickText(page, "City board");
  await page.waitForSelector(".board-tile", { timeout: 60_000 });
  // Thumbnails are drawn by real engine frames; a tile still drawing says "drawing…" (a live page
  // session's worth of partial runs), so give the queue a bounded chance to land.
  let tiles = { painted: 0, total: 0 };
  for (let tryNo = 0; tryNo < 30; tryNo++) {
    tiles = await page.evaluate(`(() => {
      const canvases = [...document.querySelectorAll(".board-tile canvas")];
      let painted = 0;
      for (const c of canvases) {
        const g = c.getContext("2d");
        let d;
        try { d = g.getImageData(0, 0, c.width, c.height).data; } catch { continue; }
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4 * 331) seen.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
        if (seen.size >= 8) painted++;
      }
      return { painted, total: canvases.length };
    })()`);
    if (tiles.painted >= 8) break;
    await page.waitForTimeout(1_000);
  }
  gate("board", tiles.painted >= 8,
    `${tiles.painted}/${tiles.total} tile canvases show a real frame (>=8 sampled colours)`);

  // --------------------------------------------------- Escape closes the topmost --
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const boardClosed = !(await visible(page, ".board-overlay"));
  gate("esc", boardClosed, boardClosed ? "Escape closed the board" : "the board survived Escape");

  // ------------------- keyboard: Space pauses the clock, S steps one batch (on the live run) --
  // Switch the campus to its live variant (the player's own chip) and stay on THIS run for the
  // watch gate below: pause, step, resume, then let it play to its review.
  await clickText(page, "Campus (live)", ".campus-variant-bar button");
  await page.waitForFunction("window.__campus?.isHand === false", null, { timeout: 240_000 });
  const sample = async () => page.evaluate(`(() => ({
    now: window.__campus?.snap?.now ?? 0,
    fps: Number((window.__campus?.fps?.() ?? 0).toFixed(1)),
    paused: !!window.__campus?.paused,
  }))()`);
  const pace = [];
  const a = await sample(); pace.push(`playing t=${a.now} fps=${a.fps}`);
  await page.waitForTimeout(1_500);
  const b = await sample(); pace.push(`playing t=${b.now} fps=${b.fps}`);
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
  const p1 = await sample();
  await page.waitForTimeout(1_500);
  const p2 = await sample(); pace.push(`paused t=${p1.now} fps=${p1.fps} -> t=${p2.now} fps=${p2.fps}`);
  await page.keyboard.press("s");
  await page.waitForTimeout(600);
  const s1 = await sample(); pace.push(`after S t=${s1.now} fps=${s1.fps}`);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1_500);
  const r1 = await sample(); pace.push(`resumed t=${r1.now} fps=${r1.fps}`);
  const advancing = b.now > a.now;
  const stopped = p2.now === p1.now && p1.paused === true;
  const stepped = s1.now > p2.now;
  const resumed = r1.now > s1.now;
  for (const line of pace) say(`pacing ${line}`);
  gate("keyboard", advancing && stopped && stepped && resumed,
    `advancing=${advancing} space-pauses=${stopped} s-steps=${stepped} space-resumes=${resumed}`);

  // ------------------------------------------------- watch that run to its review --
  await page.waitForFunction("!!window.__campus", null, { timeout: 240_000 });
  // 4x, then let it play: a city week is a compressed week, this is ~10-20 s of watching.
  await page.evaluate(`(() => { const s = document.querySelector(".campus-controls select");
    if (s) { s.value = "4"; s.dispatchEvent(new Event("change")); } })()`);
  let reviewUp = false;
  const watchLog = [];
  const watchDeadline = Date.now() + 120_000;
  let lastNow = -1;
  let ended = false;          // the ENGINE says the live run is over (`snap.done`)
  let offeredFallback = false;
  while (Date.now() < watchDeadline && !reviewUp) {
    reviewUp = await visible(page, ".review-overlay");
    if (reviewUp) break;
    ended = ended || await page.evaluate("window.__campus?.snap?.done === true");
    // A city week ENDS in a freeze: the offers panel is a player decision, not a cutscene. Take
    // one (that is what the game asks for); the hatch reopens it if it was ever dismissed.
    if (await visible(page, ".offers-panel .offer-card button")) {
      await page.evaluate(`document.querySelector(".offers-panel .offer-card button").click()`);
      watchLog.push("took a week-end offer");
      await page.waitForTimeout(700);
      continue;
    }
    if (await visible(page, ".offers-panel")) {
      await page.evaluate(`document.querySelector(".offers-panel .callout-actions button")?.click()`);
      watchLog.push("dismissed the offers (Later)");
      await page.waitForTimeout(400);
      continue;
    }
    if (await clickText(page, "Week end", ".campus-controls button")) {
      watchLog.push("opened the frozen week end through its hatch");
      await page.waitForTimeout(500);
      continue;
    }
    // Only AFTER the engine says this run ended: a campus whose script was skipped keeps ownership
    // of its ending, so the readout's "Review ▸" is the documented way in. One press, never a stale
    // review from a previous run.
    if (ended && !offeredFallback) {
      offeredFallback = true;
      if (await clickText(page, "Review", ".review-open")) {
        watchLog.push("opened the review from the readout (skipped-script path)");
        await page.waitForTimeout(900);
        reviewUp = await visible(page, ".review-overlay");
        if (reviewUp) break;
      }
    }
    const now = await page.evaluate("window.__campus?.snap?.now ?? -1");
    if (now !== lastNow) { watchLog.push(`t=${now}`); lastNow = now; }
    await page.waitForTimeout(1_500);
  }
  const watchBeats = watchLog.filter((line) => !line.startsWith("t="));
  for (const line of watchBeats) say(`watch ${line}`);
  gate("watch", reviewUp, `engine-ended=${ended} review=${reviewUp}`
    + `${watchBeats.length ? ` (${watchBeats.join("; ")})` : ""}`);

  // ------------------------------------------------------------------- the review --
  const reviewBits = await page.evaluate(`(() => {
    const p = document.querySelector(".review-panel");
    if (!p) return null;
    return { canvas: !!p.querySelector("canvas"),
             fair: p.querySelectorAll(".review-stats .share-row, .review-panel [class*=share-row]").length,
             share: !!p.querySelector(".campus-share-button"),
             text: (p.textContent ?? "").replace(/\\s+/g, " ").slice(0, 120) };
  })()`);
  gate("review", !!reviewBits?.canvas && !!reviewBits?.share,
    reviewBits ? `strip canvas=${reviewBits.canvas} share button=${reviewBits.share}` : "no review panel");
  await page.screenshot({ path: `${shotDir}/art9-playthrough-review.png` });

  // ---------------------------------------------------------------- mint a card --
  await clickText(page, "Share this run", ".review-panel button");
  await page.waitForSelector(".share-overlay .share-url", { timeout: 120_000 });
  const cardUrl = await page.evaluate("document.querySelector('.share-overlay .share-url').value");
  const hashInUrl = /#card=.+/.test(String(cardUrl));
  gate("mint", hashInUrl && mintLines.length > 0,
    hashInUrl ? `${String(cardUrl).length} char link, mint log ${mintLines[mintLines.length - 1]
      ?.match(/hash=(\w{8})/)?.[1]}…` : `no #card= link (got ${String(cardUrl).slice(0, 60)})`);

  // ------------------------------------- the SAME tab routes #card= and verifies --
  await page.keyboard.press("Escape");            // close the mint dialog, not the tab
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");            // …and the review it was opened from
  await page.waitForTimeout(300);
  const mintHash = /hash=(\w+)/.exec(mintLines[mintLines.length - 1] ?? "")?.[1] ?? "";
  await page.evaluate(`location.hash = "#card=" + ${JSON.stringify(String(cardUrl).split("#card=")[1] ?? "")}`);
  let verdict = null;
  for (let tryNo = 0; tryNo < 60 && !verdict; tryNo++) {
    verdict = await page.evaluate(`(() => { const b = document.querySelector(".share-overlay .share-banner");
      return b ? b.textContent : null; })()`);
    if (!verdict) await page.waitForTimeout(1_000);
  }
  const replayHash = /got=(\w+)/.exec(replayLines[replayLines.length - 1] ?? "")?.[1] ?? "";
  const verified = /verified replay/.test(String(verdict)) && mintHash !== "" && mintHash === replayHash;
  gate("card-route", verified,
    `banner "${String(verdict).slice(0, 46)}…" mint=${mintHash.slice(0, 12)} replay=${replayHash.slice(0, 12)}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // ------------------------------------------------------------------ help via ? --
  await page.keyboard.press("?");
  await page.waitForTimeout(500);
  const helpUp = await visible(page, ".help-drawer");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const helpClosed = !(await visible(page, ".help-overlay"));
  gate("help", helpUp && helpClosed, `? opened=${helpUp} Escape closed=${helpClosed}`);

  await page.close();
} catch (error) {
  console.error(`playthrough crashed: ${error}`);
  exitCode = 1;
} finally {
  await browser.close();
  console.log("\ngate            result  detail");
  for (const r of rows) console.log(`${r.gate.padEnd(15)} ${r.result.padEnd(7)} ${r.detail}`);
  console.log(`\n${rows.filter((r) => r.result === "PASS").length}/${rows.length} gates passed `
    + `in ${elapsed()} s wall`);
  if (rows.some((r) => r.result === "FAIL")) exitCode = 1;
  console.log(exitCode ? "art9 playthrough: FAILED" : "art9 playthrough: ok");
}
process.exit(exitCode);
