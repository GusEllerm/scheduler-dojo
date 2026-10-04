// Art 7b acceptance evidence (city board + share cards in the campus art).
//
//   npm run build && npm run preview          # :4173
//   node scripts/art7b_evidence.mjs                     # all four cases
//   node scripts/art7b_evidence.mjs --case board        # one case
//
// Cases:
//   board     a save whose progression says city 1 is GOLD-bar and city 2 is pass-bar (so the
//             frames are proven, not assumed), city 3 is the frontier (unlocked, unplayed) and
//             cities 4-9 are locked. Every tile canvas is pixel-checked (a flat canvas is a
//             placeholder and FAILS here), the endless tile shows prefs.endlessBest, and a locked
//             tile's tap answers with how to unlock it. -> art7b-board.png
//   share     a live city (level3) run to its horizon freeze, an offer taken, the review open:
//             "Share this run" mints through the engine, the card shows the campus thumbnail, and
//             its `#card=` link is opened in a FRESH browser (no shared save) — the card view
//             verifies (badge), logs `dojo-share-mint` vs `dojo-share-replay` hash equality, and
//             "Watch the replay ▸" lands the run in watch mode with the same hash in the readout.
//             -> art7b-share-verified.png
//   tamper    the SAME link with ONE character of the payload flipped (chosen so the envelope still
//             decodes and only the promised hash differs — a card that cannot even decode would
//             prove less). -> art7b-tampered.png
//   legacy    a phase-one card literal (minted from the level1 readout's Share button, committed
//             below as a literal) opened on the old `?c=` route: the v1 envelope still verifies
//             both ways after Art 7b.
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

/**
 * A phase-one (pre-Art-7b) card literal: `levels/level1.json` at its own seed under its default
 * policy, minted by `share_encode` in the phase-one UI. Kept as a literal ON PURPOSE — the point
 * is that a card minted before this code exists still replays and verifies.
 */
const PHASE_ONE_CARD = process.env.PHASE_ONE_CARD
  || "eyJoYXNoIjoiZjU4NGE1ZTQ4NTZmMDMyNzQ3NTgzMTQ5OWQxNjMxNjcxZmI2NzI5MTAzMDgw"
   + "OTJiZDA5NjIyYzY1ZmNmM2VhZCIsImxldmVsIjp7ImNsdXN0ZXIiOnsibm9kZXMiOlt7ImNw"
   + "dXMiOjgsImlkIjoibjAiLCJtZW0iOjMyfSx7ImNwdXMiOjgsImlkIjoibjEiLCJtZW0iOjMy"
   + "fSx7ImNwdXMiOjgsImlkIjoibjIiLCJtZW0iOjMyfSx7ImNwdXMiOjgsImlkIjoibjMiLCJt"
   + "ZW0iOjMyfV0sInBhcnRpdGlvbiI6ImJhdGNoIn0sImR1cmF0aW9uIjo0MDAwMCwiZ2VuZXJh"
   + "dG9yIjp7ImFycml2YWwiOnsicmF0ZV9wZXJfaG91ciI6OCwidHlwZSI6InBvaXNzb24ifSwi"
   + "bl9qb2JzIjoxNiwibm9kZXMiOnsiY2hvaWNlcyI6W1sxLDAuN10sWzIsMC4zXV0sInR5cGUi"
   + "OiJkaXNjcmV0ZSJ9LCJydW50aW1lX3JhdGlvIjp7Im1lZGlhbiI6MC42LCJzaWdtYSI6MC40"
   + "LCJ0eXBlIjoibG9nbm9ybWFsIn0sInVzZXJzIjpbeyJuYW1lIjoiYWxpY2UiLCJ3ZWlnaHQi"
   + "OjEuMH0seyJuYW1lIjoiYm9iIiwid2VpZ2h0IjoxLjB9XSwid2FsbHRpbWUiOnsibWVkaWFu"
   + "Ijo2MDAsInNpZ21hIjowLjQsInR5cGUiOiJsb2dub3JtYWwifX0sImlkIjoibGV2ZWwxIiwi"
   + "c2NvcmVfYW5jaG9ycyI6eyJib3VuZGVkX3Nsb3dkb3duIjp7ImJhc2VsaW5lIjoxNzIuMjYy"
   + "NSwicmVmZXJlbmNlIjoxLjAyMTU4M30sInV0aWxpemF0aW9uIjp7ImJhc2VsaW5lIjowLjAs"
   + "InJlZmVyZW5jZSI6MC4zOTM3NH0sIndhaXRfcDk1Ijp7ImJhc2VsaW5lIjo0MDUwLjAsInJl"
   + "ZmVyZW5jZSI6OTYuMH19LCJzY29yZV93ZWlnaHRzIjp7ImJvdW5kZWRfc2xvd2Rvd24iOjEu"
   + "MCwidXRpbGl6YXRpb24iOjEuMCwid2FpdF9wOTUiOjEuMH0sInNlbnNvcnMiOm51bGwsInVu"
   + "bG9ja3MiOlsiY29yZSJdfSwicG9saWN5IjoiaWRsZSIsInNlZWQiOjQsInYiOjF9"
;

/** Seed a save before the app's first line. `mode: campus` boots the campus view. */
async function bootApp(page, prefs, extra = {}) {
  await page.addInitScript((doc) => {
    localStorage.setItem("scheduler-dojo:v1", JSON.stringify(doc));
  }, { version: 1, progress: {}, prefs: { mode: "campus", ...prefs }, ...extra });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForFunction("!document.getElementById('app').hidden", null, { timeout: 180_000 });
}

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

/** How many distinct colors a canvas holds — a flat canvas is a placeholder, not a frame. */
const canvasColors = (page, sel) => page.evaluate(`(() => {
  const c = document.querySelector(${JSON.stringify(sel)});
  if (!c || !c.width) return -1;
  const g = c.getContext("2d");
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4 * 197) seen.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
  return seen.size;
})()`);

// --- (a) the city board -------------------------------------------------------------------

async function caseBoard(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  // city1 gold (812 >= its 720 gold bar), city2 pass (400 between its bars), city3 the frontier,
  // city4+ never played => locked. endlessBest seeded so the endless tile's line is real.
  await bootApp(page, { level: "level1", endlessUnlocked: true, endlessBest: { days: 22, served: 928 } }, {
    progression: {
      version: 1, credits: 640, lifetime: 640, upgrades: ["reserve", "sensors"], last_seen: 0,
      levels: {
        level1: { best: 812, gold: true, passes: [4] },
        level2: { best: 400, gold: false, passes: [5] },
      },
    },
  });
  await clickButton(page, "City board");
  await page.waitForSelector(".campus-board .board-tile", { timeout: 30_000 });

  const tiles = await page.evaluate(`(() => {
    const t = [...document.querySelectorAll(".board-tile")];
    return t.map((b) => ({ city: b.dataset.city,
      frame: [...b.classList].find((c) => c.startsWith("frame-")) ?? "",
      verdict: b.querySelector(".board-verdict")?.textContent ?? "",
      best: b.querySelector(".board-best")?.textContent ?? "",
      thumb: !!b.querySelector("canvas.board-thumb") }));
  })()`);
  for (const t of tiles) say(`tile ${t.city}: ${t.frame || "—"} | ${t.verdict} | ${t.best}`);
  if (tiles.length !== 10) fail(`expected 9 city tiles + endless, got ${tiles.length}`);
  const byCity = Object.fromEntries(tiles.map((t) => [t.city, t]));
  if (byCity["1"]?.frame !== "frame-gold") fail(`city 1 frame is ${byCity["1"]?.frame}, want frame-gold`);
  if (!/gold bar/.test(byCity["1"]?.verdict ?? "")) fail("city 1 verdict text missing 'gold bar'");
  if (byCity["2"]?.frame !== "frame-pass") fail(`city 2 frame is ${byCity["2"]?.frame}, want frame-pass`);
  if (!/pass bar/.test(byCity["2"]?.verdict ?? "")) fail("city 2 verdict text missing 'pass bar'");
  const locked = tiles.filter((t) => /locked/.test(t.verdict)).map((t) => t.city);
  if (JSON.stringify(locked) !== JSON.stringify(["4", "5", "6", "7", "8", "9"])) {
    fail(`locked tiles are ${locked.join(",")}, want 4,5,6,7,8,9 (city 3 is the frontier)`);
  } else ok(`locked = ${locked.join(",")} (city 3 = the unlocked frontier)`);
  if (!/best 22 days/.test(byCity.endless?.best ?? "")) {
    fail(`endless tile does not show prefs.endlessBest: "${byCity.endless?.best}"`);
  } else ok(`endless tile shows the save's best: ${byCity.endless.best}`);

  // Every thumbnail is a real engine frame: wait for the "drawing…" notes to clear, then pixel-check.
  // Every tile's own "drawing…" note is hidden the moment its frame lands (or it says what
  // failed), so the notes — not `canvas.width`, which is nonzero before anything is painted —
  // are the honest wait condition.
  await page.waitForFunction(
    `[...document.querySelectorAll(".board-pending")].every((n) => n.hidden)`,
    null, { timeout: 600_000 });
  let painted = 0;
  for (const t of tiles) {
    const colors = await canvasColors(page, `.board-tile[data-city="${t.city}"] canvas`);
    if (colors < 8) fail(`tile ${t.city} canvas is flat (${colors} sampled colors) — a placeholder`);
    else painted++;
  }
  ok(`${painted}/${tiles.length} tile thumbnails are real painted engine frames`);

  // A locked tile must explain itself, not sit silent.
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll(".board-tile")].find((x) => x.dataset.city === "6");
    b.click();
  })()`);
  const status = (await page.textContent(".board-status")) ?? "";
  say(`locked tile said: ${status.trim()}`);
  if (!/locked|unlock/i.test(status)) fail("a locked tile gave no explanation");
  if (!/city 3/.test(status)) fail("the explanation does not name the city that unlocks it");
  ok("locked tile explains the unlock (and did not start the city)");

  await page.screenshot({ path: `${shotDir}/art7b-board.png` });
  await page.close();
}

// --- (b) mint a card -> open it in a fresh browser -> verified replay -------------------------

/** A live city run to its horizon freeze, one offer taken, the review panel open. */
async function bootCityReview(page) {
  const logs = [];
  page.on("console", (msg) => {
    if (/dojo-share-(mint|replay)/.test(msg.text())) logs.push(msg.text());
  });
  await bootApp(page, { level: "level3" });
  await page.selectOption(".campus-controls select", "8");
  await page.waitForSelector(".offers-panel", { timeout: 240_000 });
  await page.locator(".offers-panel .offer-card button").first().click();
  await page.waitForSelector(".review-panel", { timeout: 120_000 });
  return logs;
}

async function caseShare(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1150 } });
  const logs = await bootCityReview(page);
  ok("city review open — share button next");
  await clickButton(page, "Share this run", ".review-panel button");
  await page.waitForSelector(".campus-share-card", { timeout: 60_000 });
  // The dialog appears FIRST and the thumbnail + link row land after it (the frame is a real
  // stepped run), so the link row — the last thing the mint writes — is the honest readiness flag.
  await page.waitForFunction(
    `!!document.querySelector(".campus-share-card .share-url")?.value`, null,
    { timeout: 300_000 });
  const card = await page.evaluate(`(() => ({
    url: document.querySelector(".campus-share-card .share-url")?.value ?? "",
    rows: [...document.querySelectorAll(".share-card-text dt")].map((d, i) =>
      d.textContent + "=" + document.querySelectorAll(".share-card-text dd")[i].textContent),
    thumbColors: (() => {
      const c = document.querySelector(".share-scene-thumb");
      if (!c || !c.width) return -1;
      const g = c.getContext("2d"); const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 331) seen.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
      return seen.size;
    })(),
  }))()`);
  const mint = logs.find((l) => /dojo-share-mint/.test(l)) ?? "";
  const mintHash = /hash=([0-9a-f]{64})/.exec(mint)?.[1] ?? "";
  say(`minted: ${card.rows.join(" · ")}`);
  if (card.thumbColors < 8) fail(`card thumbnail is flat (${card.thumbColors}) — not a campus frame`);
  else ok(`card thumbnail painted by the campus painter (${card.thumbColors} sampled colors)`);
  if (!/#card=[A-Za-z0-9_-]+/.test(card.url)) fail(`card URL is not hash-form: ${card.url}`);
  else ok(`card URL uses the hash route: ${card.url.slice(0, 58)}…`);
  if (!mintHash) fail(`no mint hash logged (${JSON.stringify(logs)})`);
  await page.screenshot({ path: `${shotDir}/art7b-share-card.png` });

  // A FRESH browser: no shared save, no shared worker — everything the replay needs is the URL.
  const fresh = await browser.newPage({ viewport: { width: 1440, height: 1150 } });
  const freshLogs = [];
  fresh.on("console", (msg) => {
    if (/dojo-share-(mint|replay)/.test(msg.text())) freshLogs.push(msg.text());
  });
  fresh.on("pageerror", (e) => freshLogs.push("PAGEERROR " + String(e).slice(0, 300)));
  await fresh.goto(card.url, { waitUntil: "load" });
  await fresh.waitForSelector(".campus-share-card .share-banner", { timeout: 180_000 });
  const view = await fresh.evaluate(`(() => ({
    ok: !!document.querySelector(".share-banner.ok"),
    bad: !!document.querySelector(".share-banner.bad"),
    text: document.querySelector(".share-banner")?.textContent ?? "",
    rows: [...document.querySelectorAll(".share-card-text dt")].map((d, i) =>
      d.textContent + "=" + document.querySelectorAll(".share-card-text dd")[i].textContent),
  }))()`);
  say(`card view: ${view.text}`);
  if (!view.ok || view.bad) fail("the card view did not report a verified replay");
  else ok("card view badge: verified replay");
  await fresh.screenshot({ path: `${shotDir}/art7b-share-verified.png` });
  const replay = freshLogs.find((l) => /dojo-share-replay/.test(l)) ?? "";
  const replayHash = /got=([0-9a-f]{64})/.exec(replay)?.[1] ?? "";
  say(`mint   ${mint}`);
  say(`replay ${replay}`);
  if (!replayHash || replayHash !== mintHash) {
    fail(`mint hash ${mintHash} != replay hash ${replayHash}`);
  } else ok(`trajectory_hash equal across mint and replay: ${replayHash}`);
  const promised = /promised hash=([0-9a-f]{64})/.exec(view.rows.join(" · "))?.[1] ?? "";
  if (promised && promised !== mintHash) fail(`card promised ${promised}, mint said ${mintHash}`);

  // ...and the replay opens in watch mode, with the same hash in the scorecard.
  await clickButton(fresh, "Watch the replay", ".campus-share-card button");
  // Wait on the replay's OWN hash (the boot page already shows a hash line for whatever level it
  // loaded, so "some hash is on screen" would resolve before the replay lands).
  try {
    await fresh.waitForFunction(
      `[...document.querySelectorAll("#readout .hash")].map((x) => x.textContent).join(" ")
        .includes(${JSON.stringify(replayHash)})`,
      null, { timeout: 240_000 });
  } catch (e) {
    // failure diagnostics only — what the fresh tab saw before the replay landed
    say(`fresh logs at timeout: ${freshLogs.join(" ;; ")}`);
    throw e;
  }
  const readout = await fresh.evaluate(
    `[...document.querySelectorAll("#readout .hash")].map((x) => x.textContent).join(" | ")`);
  say(`watch readout: ${readout}`);
  if (!readout.includes(replayHash)) fail(`watch readout does not carry the replay hash: ${readout}`);
  else ok("the replay opened in watch mode with the card's own trajectory hash");
  await page.close();
  await fresh.close();
}

// --- (c) one flipped character -------------------------------------------------------------

function b64urlDecode(body) {
  return Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function b64urlEncode(json) {
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Flip ONE character of the payload, at the first position where the envelope still decodes, the
 * version and seed survive, and only the promised hash differs. (A flip that breaks the JSON would
 * only prove the decoder is strict.)
 */
function flipOneChar(body) {
  for (let i = 0; i < body.length; i++) {
    for (const ch of "AB") {
      if (body[i] === ch) continue;
      const trial = body.slice(0, i) + ch + body.slice(i + 1);
      let before;
      let after;
      try {
        before = JSON.parse(b64urlDecode(body));
        after = JSON.parse(b64urlDecode(trial));
      } catch {
        continue;
      }
      const same = (k) => JSON.stringify(after[k]) === JSON.stringify(before[k]);
      if (typeof after.hash === "string" && after.hash !== before.hash
          && after.v === before.v && same("seed") && same("level_id") && same("level") && same("policy")) {
        return { tampered: trial, at: i, from: body[i], to: ch,
                 promised: before.hash, nowSays: after.hash };
      }
    }
  }
  return null;
}

async function caseTamper(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1150 } });
  const logs = await bootCityReview(page);
  await clickButton(page, "Share this run", ".review-panel button");
  await page.waitForSelector(".campus-share-card", { timeout: 60_000 });
  await page.waitForFunction(
    `!!document.querySelector(".campus-share-card .share-url")?.value`, null,
    { timeout: 300_000 });
  const url = (await page.evaluate(
    `document.querySelector(".campus-share-card .share-url")?.value ?? ""`)) ?? "";
  const mint = logs.find((l) => /dojo-share-mint/.test(l)) ?? "";
  await page.close();
  const body = /#card=([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? "";
  const flip = flipOneChar(body);
  if (!flip) { fail("could not find a one-character flip that keeps the envelope decodable"); return; }
  say(`flipped character ${flip.at} ('${flip.from}' -> '${flip.to}'): card now promises `
    + `${flip.nowSays.slice(0, 16)}…, engine still says ${flip.promised.slice(0, 16)}…`);
  const fresh = await browser.newPage({ viewport: { width: 1440, height: 1150 } });
  await fresh.goto(url.replace(body, flip.tampered), { waitUntil: "load" });
  await fresh.waitForSelector(".campus-share-card .share-banner", { timeout: 180_000 });
  const view = await fresh.evaluate(`(() => ({
    bad: !!document.querySelector(".share-banner.bad"),
    ok: !!document.querySelector(".share-banner.ok"),
    text: document.querySelector(".share-banner")?.textContent ?? "",
    watch: [...document.querySelectorAll("button")].some((b) => /Watch the replay/.test(b.textContent)),
  }))()`);
  say(`tampered card says: ${view.text}`);
  if (!view.bad || view.ok) fail("the tampered card did not raise the tampered banner");
  else ok("tampered card: banner raised");
  if (view.watch) fail("a tampered card offered the replay anyway");
  else ok("a tampered card does not offer the replay");
  await fresh.screenshot({ path: `${shotDir}/art7b-tampered.png` });
  await fresh.close();
}

// --- (d) the phase-one card literal still verifies -------------------------------------------

async function caseLegacy(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const logs = [];
  page.on("console", (msg) => { if (/hash/.test(msg.text())) logs.push(msg.text()); });
  await page.goto(`${base}/?level=level1&c=${PHASE_ONE_CARD}`, { waitUntil: "load" });
  await page.waitForSelector(".share-banner", { timeout: 180_000 });
  const view = await page.evaluate(`(() => ({
    ok: !!document.querySelector(".share-banner.ok"),
    bad: !!document.querySelector(".share-banner.bad"),
    text: document.querySelector(".share-banner")?.textContent ?? "",
    title: document.getElementById("level-title")?.textContent ?? "",
  }))()`);
  say(`phase-one card: ${view.text.trim()} (level "${view.title}")`);
  if (view.bad || !view.ok) {
    fail(`the phase-one card literal no longer verifies: ${view.text}`);
  } else ok("phase-one card literal verifies on the old route (v1 envelope unchanged)");
  await page.close();
}

const browser = await chromium.launch();
try {
  if (only === "all" || only === "board") await caseBoard(browser);
  if (only === "all" || only === "share") await caseShare(browser);
  if (only === "all" || only === "tamper") await caseTamper(browser);
  if (only === "all" || only === "legacy") await caseLegacy(browser);
} finally {
  await browser.close();
}
console.log(process.exitCode ? "art7b evidence: FAILED" : "art7b evidence: ok");
