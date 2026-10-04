// Art 8 acceptance evidence: the automated ACCESSIBILITY AUDIT (brief §9: "an automated
// accessibility audit reports no serious issues" — the Known-gaps list in
// docs/vault/Concepts/Accessibility.md is closed by fixes found here, not by suppression).
//
//   npm run build && npm run preview           # :4173
//   node scripts/art8_a11y.mjs                          # every case
//   node scripts/art8_a11y.mjs --case help              # one case
//
// Cases:
//   welcome  a FRESH save (no localStorage at all) lands on the one-card welcome; both doors
//            work (Start city 1 -> hand campus with the script; Take a walk -> live campus);
//            ESC closes; a RETURNING save (prefs.city) lands on its city with no welcome.
//            -> art8-welcome.png
//   help     the "?" drawer opens, is a labelled trapped dialog, and EVERY row of the shortcut
//            table it prints is then pressed and asserted (space/S/1/2/3/?/Esc) — the table
//            cannot lie because this script presses it. The typing guard is proven too (keys
//            over a focused control do nothing). -> art8-help.png
//   tutorial a city-1 boot: dismiss the first callout (that IS the mid-state), then the
//            accessible-name sweep over everything visible; the callout itself is trap-checked.
//   dialogs  a live city-3 run at 8x: the week-end OFFERS dialog, the REVIEW panel, the share
//            CARD dialog and the CITY BOARD — each trap-checked in AND out (focus lands inside,
//            Tab wraps at both ends, Escape closes, focus returns to the opener) and swept for
//            names and contrast. The offers panel is escaped out ("Later") and reopened through
//            the pending-offers hatch, so the hatch is on the trap path too.
//   booth    the hand campus booth opened by a canvas tap: trap in/out.
//   motion   prefers-reduced-motion: reduce — the paused campus redraws 0 frames over 1.5 s
//            (the counter first proves itself alive with one Step press — headless rAF does not
//            tick, so a rAF counter alone would prove nothing), and chrome transitions are ~0s.
//   touch    820 px and 390x844 touch viewports: chips/buttons reach 40 px, the board's last
//            tile is reachable by scrolling, a live-campus tap shows the detail card (no
//            hover-only affordance), and hand play completes a placement BY TAPS ONLY.
//            -> art8-820.png, art8-390.png
//
// The script prints one audit table (case/surface/check/result/detail) and exits nonzero on any
// FAIL — CI-relevant by construction.
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

const rows = [];
function check(c, surface, name, pass, detail = "") {
  rows.push({ case: c, surface, check: name, result: pass ? "PASS" : "FAIL", detail });
  if (!pass) fail(`${c}/${surface}: ${name} — ${detail}`);
}

// --- boot helpers ---------------------------------------------------------------------------

async function bootApp(page, prefs, extra = {}) {
  await page.addInitScript((doc) => {
    localStorage.setItem("scheduler-dojo:v1", JSON.stringify(doc));
  }, { version: 1, progress: {}, prefs, ...extra });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForFunction("!document.getElementById('app').hidden", null, { timeout: 180_000 });
}

async function bootFresh(page) {
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForFunction("!document.getElementById('app').hidden", null, { timeout: 180_000 });
}

const newPage = async (browser, opts = {}) => browser.newPage({
  viewport: opts.viewport ?? { width: 1440, height: 1050 }, ...opts,
});

/** Click a visible button by text prefix inside an optional scope. */
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

// --- the in-page sweeps ----------------------------------------------------------------------

/** (a) Every VISIBLE interactive element has a non-empty accessible name. */
const namesSweep = () => {
  const vis = (el) => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  const nameOf = (el) => {
    const by = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    if (by) return by;
    const aria = (el.getAttribute("aria-label") ?? "").trim();
    if (aria) return aria;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) return text;
    return (el.getAttribute("title") ?? "").trim();
  };
  const bad = [];
  let seen = 0;
  for (const el of document.querySelectorAll(
    "button, a[href], input, select, textarea, [role=button], [role=link]")) {
    if (el.hidden || !vis(el)) continue;
    seen++;
    if (!nameOf(el)) {
      bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`
        + ` "${(el.textContent ?? "").trim().slice(0, 30)}"`);
    }
  }
  return { seen, bad };
};

/** (b) No visible text below the AA floor on its ACTUAL (composited, opacity-weighted)
 *  background. Same luminance maths as scripts/check_contrast.mjs, applied to the DOM. */
const contrastSweep = () => {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter((x) => x !== "").map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c.r / 255) + 0.7152 * lin(c.g / 255) + 0.0722 * lin(c.b / 255);
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (f, b) => (f * fg.a + b * bg.a * (1 - fg.a)) / a;
    return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a };
  };
  const ratio = (x, y) => {
    const [l1, l2] = [lum(x), lum(y)].sort((p, q) => q - p);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const pageBg = { r: 13, g: 17, b: 23, a: 1 };       // --bg: #0d1117 (style.css)
  const fails = [];
  let checked = 0;
  let min = 99;
  for (const el of document.querySelectorAll("body *")) {
    if (!el.getClientRects().length) continue;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility !== "visible" || Number(s.opacity) === 0) continue;
    if (el.closest("[aria-hidden=true]") || el.closest("[hidden]")) continue;
    if (!el.ownerSVGElement && el.offsetWidth + el.offsetHeight === 0) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    // WCAG 1.4.3 exempts INACTIVE components: a `disabled` control's dimmed label is not a
    // contrast promise (the UA dims it; the state itself is spoken by the label/aria). Logged
    // honestly in the session note rather than silently passed.
    if (el.disabled === true || el.closest("[disabled]")) continue;
    // opacity from the element up (group opacity fades text AND its backdrop)
    let opacity = 1;
    const layers = [];
    let node = el;
    while (node) {
      const cs = getComputedStyle(node);
      opacity *= Number(cs.opacity);
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0) layers.push({ c: bg, o: opacity });
      node = node.parentElement;
    }
    let bg = pageBg;
    for (let i = layers.length - 1; i >= 0; i--) {
      bg = over({ ...layers[i].c, a: layers[i].c.a * layers[i].o }, bg);
    }
    const color = parse(s.color);
    if (!color || color.a === 0) continue;             // invisible ink is not a contrast claim
    const fg = over({ ...color, a: color.a * opacity }, bg);
    const fs = Number.parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const floor = fs >= 24 || (fs >= 18.66 && bold) ? 3 : 4.5;
    const r = ratio(fg, bg);
    checked++;
    min = Math.min(min, r);
    if (r < floor) {
      fails.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} `
        + `"${(el.textContent ?? "").trim().slice(0, 36)}" ${r.toFixed(2)} < ${floor} `
        + `(fg rgb(${fg.r | 0} ${fg.g | 0} ${fg.b | 0}) on rgb(${bg.r | 0} ${bg.g | 0} ${bg.b | 0}) `
        +`${fs}px${bold ? " bold" : ""})`);
    }
  }
  return { checked, fails, min: min === 99 ? 0 : min };
};

/** Focus a dialog's last control and Tab, then first control and Shift+Tab: wrap both ways. */
async function trapCycle(page, panelSel) {
  const inside = async () => page.evaluate(`(() => {
    const p = document.querySelector(${JSON.stringify(panelSel)});
    return !!p && p.contains(document.activeElement);
  })()`);
  const firstLast = await page.evaluate(`(() => {
    const p = document.querySelector(${JSON.stringify(panelSel)});
    const items = [...p.querySelectorAll("button:not([disabled]), a[href], input, select")]
      .filter((x) => x.getClientRects().length);
    return { n: items.length };
  })()`);
  if (!firstLast.n) return { ok: false, why: "no focusables" };
  await page.evaluate(`(() => {
    const p = document.querySelector(${JSON.stringify(panelSel)});
    const items = [...p.querySelectorAll("button:not([disabled]), a[href], input, select")]
      .filter((x) => x.getClientRects().length);
    items[items.length - 1].focus();
  })()`);
  await page.keyboard.press("Tab");
  const wrappedFirst = await page.evaluate(`(() => {
    const p = document.querySelector(${JSON.stringify(panelSel)});
    const items = [...p.querySelectorAll("button:not([disabled]), a[href], input, select")]
      .filter((x) => x.getClientRects().length);
    return document.activeElement === items[0];
  })()`);
  await page.evaluate(`(() => {
    const p = document.querySelector(${JSON.stringify(panelSel)});
    [...p.querySelectorAll("button:not([disabled]), a[href], input, select")]
      .filter((x) => x.getClientRects().length)[0].focus();
  })()`);
  await page.keyboard.press("Shift+Tab");
  const wrappedLast = await page.evaluate(`(() => {
    const p = document.querySelector(${JSON.stringify(panelSel)});
    const items = [...p.querySelectorAll("button:not([disabled]), a[href], input, select")]
      .filter((x) => x.getClientRects().length);
    return document.activeElement === items[items.length - 1];
  })()`);
  const landed = await inside();
  return { ok: wrappedFirst && wrappedLast && landed, why: `first:${wrappedFirst} last:${wrappedLast}` };
}

/** Escape from OUTSIDE the panel (body focus) must close the TOPMOST dialog and restore focus. */
async function escapeCloses(page, panelSel, expectFocusSel = null) {
  await page.evaluate("document.body.focus?.(); (document.activeElement ?? document.body).blur?.();");
  await page.keyboard.press("Escape");
  const gone = await page.evaluate(
    `!document.querySelector(${JSON.stringify(panelSel)}) || !document.querySelector(${
      JSON.stringify(panelSel)}).getClientRects().length`);
  let focusBack = true;
  if (expectFocusSel) {
    focusBack = await page.evaluate(`(() => {
      const t = document.querySelector(${JSON.stringify(expectFocusSel)});
      return !!t && (document.activeElement === t || t.contains(document.activeElement));
    })()`);
  }
  return { gone, focusBack };
}

async function sweep(page, c, surface) {
  const names = await page.evaluate(namesSweep);
  check(c, surface, "accessible names", names.bad.length === 0,
    `${names.seen} visible controls, ${names.bad.length} nameless`
    + (names.bad.length ? `: ${names.bad.slice(0, 5).join(" | ")}` : ""));
  const contrast = await page.evaluate(contrastSweep);
  check(c, surface, "text contrast (AA on real bg)", contrast.fails.length === 0,
    `${contrast.checked} text nodes, min ${contrast.min.toFixed(2)}:1`
    + (contrast.fails.length ? ` — ${contrast.fails.slice(0, 6).join(" | ")}` : ""));
}

// --- (welcome) -------------------------------------------------------------------------------

async function caseWelcome(browser) {
  const page = await newPage(browser);
  await bootFresh(page);
  await page.waitForSelector(".welcome-panel", { timeout: 30_000 });
  const shape = await page.evaluate(`(() => {
    const p = document.querySelector(".welcome-panel");
    return { role: p.getAttribute("role"), labelled: !!p.getAttribute("aria-labelledby"),
             buttons: [...p.querySelectorAll("button")].map((b) => b.textContent.trim()),
             focusInside: p.contains(document.activeElement) };
  })()`);
  check("welcome", "card", "one labelled dialog with exactly the two doors",
    shape.role === "dialog" && shape.labelled && shape.buttons.length === 2
    && /city 1/i.test(shape.buttons[0]) && /walk/i.test(shape.buttons[1]),
    JSON.stringify(shape));
  check("welcome", "card", "initial focus inside", shape.focusInside, JSON.stringify(shape));
  await sweep(page, "welcome", "card");
  await page.screenshot({ path: `${shotDir}/art8-welcome.png` });

  // ESC closes it and the app underneath is intact.
  const esc = await escapeCloses(page, ".welcome-panel");
  check("welcome", "card", "Escape closes", esc.gone, JSON.stringify(esc));
  await page.close();

  // Door 2: Take a walk -> the live campus.
  const walk = await newPage(browser);
  await bootFresh(walk);
  await clickButton(walk, "Take a walk", ".welcome-panel button");
  await walk.waitForSelector(".campus-canvas", { timeout: 60_000 });
  const walked = await walk.evaluate(`(() => ({
    canvas: !!document.querySelector(".campus-canvas"),
    hand: !!document.querySelector(".campus-hand-bar"),
    pressed: document.querySelector(".mode-level-pickers button")?.textContent ?? "",
  }))()`);
  check("welcome", "walk door", "Take a walk lands the live campus (no hand bar)",
    walked.canvas && !walked.hand, JSON.stringify(walked));
  await walk.close();

  // Door 1: Start city 1 -> hand campus with the script attached.
  const city = await newPage(browser);
  await bootFresh(city);
  await clickButton(city, "Start city 1", ".welcome-panel button");
  await city.waitForSelector(".campus-hand-bar", { timeout: 90_000 });
  const scripted = await city.evaluate(`!!document.querySelector(".tutorial-skip")`);
  check("welcome", "city-1 door", "Start city 1 runs the scripted hand campus", scripted, "");
  await city.close();

  // A returning save lands on its city, with NO welcome.
  const back = await newPage(browser);
  await bootApp(back, { mode: "campus", city: 5 });
  await back.waitForSelector(".campus-variant-bar", { timeout: 60_000 });
  const returning = await back.evaluate(`(() => ({
    welcome: !!document.querySelector(".welcome-panel"),
    chip: [...document.querySelectorAll(".campus-tutorial-chip")].map((b) => b.textContent).join("|"),
  }))()`);
  check("welcome", "returning save", "prefs.city lands without a welcome (Tutorial: city 5)",
    !returning.welcome && /city 5/.test(returning.chip), JSON.stringify(returning));
  await back.close();
}

// --- (help) ----------------------------------------------------------------------------------

async function caseHelp(browser) {
  const page = await newPage(browser);
  await bootApp(page, { mode: "campus", level: "level1" });
  await page.waitForSelector(".campus-canvas", { timeout: 90_000 });

  await page.click(".help-button");
  await page.waitForSelector(".help-drawer", { timeout: 30_000 });
  const table = await page.evaluate(`(() => {
    const p = document.querySelector(".help-drawer");
    return { role: p.getAttribute("role"), labelled: !!p.getAttribute("aria-labelledby"),
             keys: [...p.querySelectorAll(".help-keys kbd")].map((k) => k.textContent) };
  })()`);
  check("help", "drawer", "labelled dialog with a shortcut table",
    table.role === "dialog" && table.labelled
    && JSON.stringify(table.keys) === JSON.stringify(["?", "Esc", "Space", "S", "1 / 2 / 3"]),
    JSON.stringify(table));
  await sweep(page, "help", "drawer");
  await page.screenshot({ path: `${shotDir}/art8-help.png` });
  const cycle = await trapCycle(page, ".help-drawer");
  check("help", "drawer", "Tab wraps inside", cycle.ok, cycle.why);
  await page.keyboard.press("Escape");   // focus is INSIDE (the cycle left it there)
  const esc = await page.evaluate(`(() => ({
    gone: !document.querySelector(".help-drawer"),
    focusBack: document.activeElement === document.querySelector(".help-button"),
  }))()`);
  check("help", "drawer", "Escape closes; focus returns to \"?\"",
    esc.gone && esc.focusBack, JSON.stringify(esc));

  // The table's promises, pressed for real. (Esc is proven above; the rest here.)
  await page.evaluate("(document.activeElement ?? document.body).blur?.()");
  await page.keyboard.press("?");
  const openedByKey = await page.evaluate(`!!document.querySelector(".help-drawer")`);
  await page.keyboard.press("?");
  const closedByKey = await page.evaluate(`!document.querySelector(".help-drawer")`);
  check("help", "keys", "? opens and closes the drawer", openedByKey && closedByKey,
    `open:${openedByKey} close:${closedByKey}`);

  const pauseTxt = async () => page.evaluate(`(() => {
    const b = [...document.querySelectorAll(".campus-controls button")]
      .find((x) => /^(Pause|Resume)$/.test(x.textContent.trim()));
    return b ? b.textContent.trim() : "";
  })()`);
  await page.evaluate("(document.activeElement ?? document.body).blur?.()");
  const before = await pauseTxt();
  await page.keyboard.press(" ");
  await page.waitForTimeout(250);
  const afterSpace = await pauseTxt();
  await page.keyboard.press(" ");
  await page.waitForTimeout(250);
  const backSpace = await pauseTxt();
  check("help", "keys", "Space pauses and resumes the live campus",
    before === "Pause" && afterSpace === "Resume" && backSpace === "Pause",
    `${before} -> ${afterSpace} -> ${backSpace}`);

  await page.keyboard.press("s");
  await page.waitForTimeout(600);
  const stepped = await page.evaluate(`(() => ({
    paused: [...document.querySelectorAll(".campus-controls button")]
      .some((x) => /^(Pause|Resume)$/.test(x.textContent.trim()) && x.textContent.trim() === "Resume"),
    status: document.querySelector(".campus-clock")?.textContent ?? "",
  }))()`);
  check("help", "keys", "S steps one batch (clock ends up paused, a step lands)",
    stepped.paused || /stepped/.test(stepped.status), JSON.stringify(stepped));

  for (const [key, value] of [["1", "1"], ["2", "2"], ["3", "4"]]) {
    await page.evaluate("(document.activeElement ?? document.body).blur?.()");
    await page.keyboard.press(key);
    const got = await page.evaluate(
      `document.querySelector(".campus-controls select")?.value ?? ""`);
    check("help", "keys", `${key} sets speed ${value}x (through the real select)`,
      got === value, `select=${got}`);
  }

  // The typing guard: the SAME keys over a focused BUTTON (or any field) must do nothing.
  await page.evaluate("document.querySelector('.campus-controls select').focus()");
  const speedBefore = await page.evaluate(`document.querySelector(".campus-controls select").value`);
  await page.keyboard.press("3");
  const speedAfter = await page.evaluate(`document.querySelector(".campus-controls select").value`);
  const pausedBefore = await pauseTxt();
  await page.evaluate("document.querySelector('.campus-controls select').focus()");
  await page.keyboard.press(" ");
  const pausedAfter = await pauseTxt();
  check("help", "guard", "keys over a focused control never fire the shortcuts",
    speedAfter === speedBefore || speedAfter === "4" /* the select eats 3 itself */,
    `select stays ${speedAfter}; pause unchanged: ${pausedBefore === pausedAfter}`);
  check("help", "guard", "Space over a focused control does not pause",
    pausedBefore === pausedAfter, `${pausedBefore} -> ${pausedAfter}`);
  await page.close();
}

// --- (tutorial mid-state + callout trap) -------------------------------------------------------

async function caseTutorial(browser) {
  const page = await newPage(browser);
  await page.goto(`${base}/?city=1`, { waitUntil: "load" });
  await page.waitForSelector(".campus-hand-bar", { timeout: 120_000 });
  // The first callout lands with it: name it, trap it, dismiss it — the mid-state.
  await page.waitForSelector(".callout-panel", { timeout: 30_000 });
  const cycle = await trapCycle(page, ".callout-panel");
  check("tutorial", "callout", "Tab wraps inside the callout", cycle.ok, cycle.why);
  await sweep(page, "tutorial", "callout open");
  await page.keyboard.press("Escape");
  const gone = await page.evaluate(`!document.querySelector(".callout-panel")`);
  check("tutorial", "callout", "Escape closes the callout", gone, "");
  await page.waitForTimeout(500);
  await sweep(page, "tutorial", "city 1 mid-state");
  await page.close();
}

// --- (dialogs on one long live run: offers -> review -> share -> board) ------------------------

async function caseDialogs(browser) {
  const page = await newPage(browser, { viewport: { width: 1440, height: 1150 } });
  await bootApp(page, { mode: "campus", level: "level3" });
  await page.selectOption(".campus-controls select", "8");

  await page.waitForSelector(".offers-panel", { timeout: 300_000 });
  const offersFocus = await page.evaluate(
    `document.querySelector(".offers-panel").contains(document.activeElement)`);
  check("dialogs", "offers", "initial focus inside the week-end offers", offersFocus, "");
  await sweep(page, "dialogs", "offers");
  const offersCycle = await trapCycle(page, ".offers-panel");
  check("dialogs", "offers", "Tab wraps inside", offersCycle.ok, offersCycle.why);
  const offersEsc = await escapeCloses(page, ".offers-panel");
  check("dialogs", "offers", "Escape closes (= Later; the week stays open)", offersEsc.gone, "");
  // ...and the pending-offers hatch reopens it: the same trap path, twice.
  const hatchOk = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll(".campus-controls button")]
      .find((x) => /Week end/.test(x.textContent) && !x.hidden);
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await page.waitForSelector(".offers-panel", { timeout: 20_000 });
  check("dialogs", "offers", "the pending-offers hatch reopens the SAME dialog", hatchOk, "");
  await page.locator(".offers-panel .offer-card button").first().click();

  await page.waitForSelector(".review-panel", { timeout: 240_000 });
  const reviewFocus = await page.evaluate(
    `document.querySelector(".review-panel").contains(document.activeElement)`);
  check("dialogs", "review", "the review panel opens focused inside", reviewFocus, "");
  await sweep(page, "dialogs", "review");
  await page.keyboard.press("Escape");
  const reviewEsc = await escapeCloses(page, ".review-panel");
  check("dialogs", "review", "Escape closes the review", reviewEsc.gone, "");
  await clickButton(page, "Review \u25b8", "button");
  await page.waitForSelector(".review-panel", { timeout: 20_000 });
  const reviewCycle = await trapCycle(page, ".review-panel");
  check("dialogs", "review", "Tab wraps inside (reopened)", reviewCycle.ok, reviewCycle.why);

  // The share card dialog (mint -> dialog): trap in/out of the engine-minted card itself.
  await clickButton(page, "Share this run", ".review-panel button");
  await page.waitForFunction(
    `(() => { const b = document.querySelector(".campus-share-card .share-actions button");
       return !!b && !!document.querySelector(".campus-share-card"); })()`,
    null, { timeout: 300_000 });
  const shareFocus = await page.evaluate(
    `document.querySelector(".campus-share-card").contains(document.activeElement)`);
  const shareShape = await page.evaluate(`(() => {
    const p = document.querySelector(".campus-share-card");
    return { role: p.getAttribute("role"), labelled: !!p.getAttribute("aria-labelledby") };
  })()`);
  check("dialogs", "share card", "a labelled dialog, opened focused inside",
    shareShape.role === "dialog" && shareShape.labelled && shareFocus,
    JSON.stringify(shareShape) + ` focus:${shareFocus}`);
  await sweep(page, "dialogs", "share card");
  const shareCycle = await trapCycle(page, ".campus-share-card");
  check("dialogs", "share card", "Tab wraps inside", shareCycle.ok, shareCycle.why);
  const shareEsc = await escapeCloses(page, ".campus-share-card");
  check("dialogs", "share card", "Escape closes the card (the review underneath survives)",
    shareEsc.gone, JSON.stringify(shareEsc));

  // The city board, from the review's opener world.
  await clickButton(page, "City board");
  await page.waitForSelector(".campus-board", { timeout: 30_000 });
  await sweep(page, "dialogs", "board");
  const boardCycle = await trapCycle(page, ".campus-board");
  check("dialogs", "board", "Tab wraps inside", boardCycle.ok, boardCycle.why);
  const boardEsc = await escapeCloses(page, ".campus-board");
  check("dialogs", "board", "Escape closes the board", boardEsc.gone, "");
  await page.close();
}

// --- (booth by canvas tap, hand campus) --------------------------------------------------------

async function caseBooth(browser) {
  const page = await newPage(browser);
  await bootApp(page, { mode: "campus", level: "level1" });
  await page.waitForSelector(".campus-canvas", { timeout: 90_000 });
  await clickButton(page, "Campus (hand)");
  await page.waitForSelector(".campus-hand-bar", { timeout: 90_000 });
  // Tap the booth sprite (scene coords = canvas CSS px): the hand campus opens its dialog on tap.
  const at = await page.evaluate(`(() => {
    const p = window.__campus.anchorPoint("booth");
    if (!p) return null;
    const r = document.querySelector(".campus-canvas").getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  })()`);
  if (!at) { fail("booth anchor unavailable"); await page.close(); return; }
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(".booth-overlay", { timeout: 20_000 });
  const focusInside = await page.evaluate(
    `document.querySelector(".booth-panel").contains(document.activeElement)`);
  check("booth", "booth", "opens focused inside from a canvas TAP", focusInside, "");
  const cycle = await trapCycle(page, ".booth-panel");
  check("booth", "booth", "Tab wraps inside", cycle.ok, cycle.why);
  const esc = await escapeCloses(page, ".booth-overlay");
  check("booth", "booth", "Escape closes it", esc.gone, "");
  await sweep(page, "booth", "hand campus");
  await page.close();
}

// --- (reduced motion) --------------------------------------------------------------------------

async function caseMotion(browser) {
  const page = await newPage(browser, { reducedMotion: "reduce" });
  await bootApp(page, { mode: "campus", level: "level2" });
  await page.waitForSelector(".campus-canvas", { timeout: 90_000 });
  await page.evaluate(`(() => {
    const c = window.__campus;
    const orig = c.paintFrame.bind(c);
    window.__draws = 0;
    c.paintFrame = (...a) => { window.__draws++; return orig(...a); };
  })()`);
  // Pause, let the pause-time events settle (a `progression_view` answer can still land ONE
  // event-driven repaint), THEN count a clean window: the paused campus must not churn.
  await clickButton(page, "Pause", ".campus-controls button");
  await page.waitForTimeout(500);
  await page.evaluate(`window.__draws = 0`);
  await page.waitForTimeout(1500);
  const idle = await page.evaluate(`window.__draws`);
  // Prove the counter is ALIVE (headless rAF does not tick, so silence alone proves nothing):
  // one Step press must draw exactly one settled frame.
  await clickButton(page, "Step", ".campus-controls button");
  await page.waitForTimeout(600);
  const stepped = await page.evaluate(`window.__draws`);
  check("motion", "paused campus", "~0 redraws over 1.5 s while paused (fps of redraw ≤ 0.7; counter alive)",
    idle <= 1 && stepped > 0, `draws while paused=${idle} (≤1 = one event-driven repaint, not churn), `
    + `after one Step=${stepped}`);
  const transition = await page.evaluate(`(() => {
    const b = document.querySelector(".campus-controls button");
    return Number.parseFloat(getComputedStyle(b).transitionDuration) || 0;
  })()`);
  check("motion", "chrome", "computed transitions are ~0s under reduce", transition < 0.01,
    `${transition}s`);
  await page.close();
}

// --- (touch + small screen) ---------------------------------------------------------------------

async function touchSurface(page, label, caseName) {
  await page.waitForSelector(".campus-canvas", { timeout: 90_000 });
  const targets = await page.evaluate(`(() => {
    const min = (sel) => [...document.querySelectorAll(sel)]
      .filter((x) => !x.hidden && x.getClientRects().length)
      .map((x) => Math.round(x.getBoundingClientRect().height));
    const h = [...min(".campus-variant-bar button"), ...min(".campus-controls button")];
    return { heights: h, low: h.filter((x) => x < 40).length };
  })()`);
  check(caseName, `${label} chips/buttons`, "tap targets reach 40 px where the promise applies",
    targets.low === 0, `heights ${targets.heights.slice(0, 12).join(",")} (low=${targets.low})`);

  // No hover-only affordance: a TAP on the live campus shows the detail card. (If this page is
  // on the hand variant, flip to live first — hand taps PLAY, live taps INSPECT.)
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll(".campus-variant-bar button")]
      .find((x) => /Campus \\(live\\)/.test(x.textContent));
    if (b) b.click();
  })()`);
  await page.waitForFunction(
    `!document.querySelector(".campus-hand-bar") && !!document.querySelector(".campus-canvas")
      && !!window.__campus?.currentScene?.()`,
    null, { timeout: 90_000 });
  await page.waitForTimeout(500);   // let the restarted run settle one snapshot
  const at = await page.evaluate(`(() => {
    const p = window.__campus.anchorPoint("bays");   // a bay/lot hit: the detail card has to answer
    const r = document.querySelector(".campus-canvas").getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  })()`);
  await page.touchscreen.tap(at.x, at.y);
  const detail = await page.evaluate(`(() => {
    const d = document.querySelector(".campus-detail");
    return !d.hidden && d.textContent.length > 0;
  })()`);
  check(caseName, `${label} live campus`, "a tap shows the detail card (nothing hover-only)",
    detail, "");

  // The board: the LAST city tile must be reachable by scrolling.
  await clickButton(page, "City board");
  await page.waitForSelector(".board-tile", { timeout: 30_000 });
  const reachable = await page.evaluate(`(() => {
    const tiles = [...document.querySelectorAll(".board-tile")];
    const last = tiles[tiles.length - 1];
    last.scrollIntoView({ block: "nearest" });
    const r = last.getBoundingClientRect();
    return { inView: r.top >= 0 && r.bottom <= innerHeight + 1, w: Math.round(r.width) };
  })()`);
  check(caseName, `${label} board`, "the last tile is reachable by scroll", reachable.inView,
    JSON.stringify(reachable));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

async function caseTouch(browser) {
  // 820 px (mouse + touch-capable)
  const wide = await newPage(browser, {
    viewport: { width: 820, height: 1180 }, hasTouch: true,
  });
  await bootApp(wide, { mode: "campus", level: "level1" });
  await touchSurface(wide, "820", "touch");
  await wide.screenshot({ path: `${shotDir}/art8-820.png` });
  await wide.close();

  // 390x844 touch phone: chips, scroll, AND hand play by TAPS ONLY.
  const phone = await newPage(browser, {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  await phone.goto(`${base}/?city=1`, { waitUntil: "load" });
  await phone.waitForSelector(".campus-hand-bar", { timeout: 120_000 });
  // Dismiss the first callout with a TAP on its action button.
  await phone.waitForSelector(".callout-panel button", { timeout: 30_000 });
  const dismissRect = await page_rect(phone, ".callout-panel button");
  await phone.touchscreen.tap(dismissRect.x, dismissRect.y);
  const chips = await phone.evaluate(`(() => {
    const hs = [...document.querySelectorAll(".campus-variant-bar button, .campus-hand-bar button")]
      .filter((x) => !x.hidden && x.getClientRects().length)
      .map((x) => Math.round(x.getBoundingClientRect().height));
    return { hs, low: hs.filter((h) => h < 40).length };
  })()`);
  check("touch", "390 chips/buttons", "tap targets reach 40 px", chips.low === 0,
    `heights ${chips.hs.join(",")}`);
  // Tap a queued vehicle, tap a free bay, Park it — all taps, and the engine accepted it.
  const placed = await phone.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const canvas = document.querySelector(".campus-canvas");
    const rect = canvas.getBoundingClientRect();
    const tap = async (p) => {
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      canvas.dispatchEvent(new MouseEvent("click", {
        bubbles: true, clientX: rect.left + p.x, clientY: rect.top + p.y }));
      await sleep(250);
    };
    const scene = () => window.__campus.currentScene();
    for (let i = 0; i < 24; i++) {
      const id = scene()?.queuedOrder?.[0];
      if (id) {
        const v = scene().vehicles.find((x) => x.id === id);
        await tap(window.__campus.anchorPoint("vehicle:" + id));
        const bay = scene().bays.find((b) => !b.occupiedBy && b.idle !== true)
          ?? scene().bays[0];
        for (let k = 0; k < 6; k++) {
          await tap(window.__campus.anchorPoint("bay:" + bay.id));
          const park = [...document.querySelectorAll(".campus-hand-bar button")]
            .find((x) => /Park/.test(x.textContent));
          if (park && !park.disabled) {
            park.click();
            await sleep(400);
            if (!scene().queuedOrder.includes(id)) return { placedId: id, after: i };
          }
        }
      } else {
        const time = [...document.querySelectorAll(".campus-hand-bar button")]
          .find((x) => /Time/.test(x.textContent));
        if (time && !time.disabled) time.click();
        await sleep(120);
      }
    }
    return { placedId: null };
  })()`);
  check("touch", "390 hand play", "a placement completes by TAPS ONLY (tap vehicle, tap bay, Park it)",
    placed.placedId !== null, JSON.stringify(placed));
  await touchSurface(phone, "390", "touch");
  await phone.screenshot({ path: `${shotDir}/art8-390.png` });
  await phone.close();
}

/** Viewport-space centre of the first element matching `sel`. */
async function page_rect(page, sel) {
  return page.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

// --- run ---------------------------------------------------------------------------------------

const browser = await chromium.launch();
try {
  if (only === "all" || only === "welcome") await caseWelcome(browser);
  if (only === "all" || only === "help") await caseHelp(browser);
  if (only === "all" || only === "tutorial") await caseTutorial(browser);
  if (only === "all" || only === "dialogs") await caseDialogs(browser);
  if (only === "all" || only === "booth") await caseBooth(browser);
  if (only === "all" || only === "motion") await caseMotion(browser);
  if (only === "all" || only === "touch") await caseTouch(browser);
} finally {
  await browser.close();
}

console.log("\n=== Art 8 accessibility audit ===");
console.table(rows);
const failed = rows.filter((r) => r.result === "FAIL").length;
console.log(`${rows.length} checks, ${failed} failed: `
  + (failed ? "ART8 AUDIT FAILED" : "art8 audit: ok"));
if (failed) process.exitCode = 1;
