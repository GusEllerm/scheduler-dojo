/**
 * Page shell: loading screen driven by real worker progress, then a level either played back
 * ("Watch (auto)") under its default policy + reference kata, or played by hand ("Play by hand",
 * Stage 5) with the HandGame controller and live gauges. The timeline renders both.
 */

import "./style.css";
import "./tokens.css"; // the --sd-* palette the campus canvas reads via tokens.ts (Art 3 left
// this to the harness page alone; a page without it renders a clock-only campus — Art 4 fix)
import { bridge, BridgeError, formatKataErrors, type Level, type RunResult } from "./bridge";
import { HandGame } from "./hand";
import { CampusPlay } from "./campus-play";
import { TutorialRunner, cityLevel, type TutorialEnding } from "./tutorial";
import { getBoothChoice, saveBoothChoice } from "./booth";
import { mountKataPlay, type KataPlayHandle } from "./kata-play";
import { levelProgress, load as loadStore, save as saveStore } from "./persistence";
import * as progression from "./progression";
import * as share from "./share";
import { mountHud, type HudHandle } from "./hud";
import { mountShop, type ShopHandle } from "./shop";
import { formatTime, mountTimeline, type TimelineHandle } from "./render/timeline";
import type { Stage, WorkerEvent } from "./worker";

const LOADER_STAGES: { stage: Stage; label: string; weight: number }[] = [
  { stage: "runtime", label: "Pyodide runtime", weight: 0.6 },
  { stage: "packages", label: "packages", weight: 0.05 },
  { stage: "wheel", label: "scheduler_dojo wheel", weight: 0.32 },
  { stage: "bridge", label: "bridge", weight: 0.03 },
];

const dom = {
  loader: must("loader"),
  note: must("loader-note"),
  fill: must("loader-fill") as HTMLElement,
  /** Optional: the progressbar wrapper around the fill (ARIA only, never fatal if absent). */
  bar: document.getElementById("loader-bar"),
  stages: must("loader-stages"),
  app: must("app"),
  title: must("level-title"),
  story: must("level-story"),
  picker: must("run-picker"),
  readout: must("readout"),
  timeline: must("timeline"),
};

function must(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

// --- loading screen -------------------------------------------------------------------

let shown = 0;
const stageStart = new Map<Stage, number>();
{
  let acc = 0;
  for (const entry of LOADER_STAGES) {
    stageStart.set(entry.stage, acc);
    acc += entry.weight;
  }
}

function paint(note: string, value: number): void {
  shown = Math.max(shown, Math.min(1, value));
  dom.fill.style.width = `${Math.round(shown * 100)}%`;
  dom.bar?.setAttribute("aria-valuenow", String(Math.round(shown * 100)));
  dom.note.textContent = note;
}

function stageLine(stage: Stage, detail: string): string {
  const label = LOADER_STAGES.find((entry) => entry.stage === stage)?.label ?? stage;
  return `${label} — ${detail}`;
}

function remember(stage: Stage, detail: string): void {
  const line = document.createElement("li");
  line.textContent = stageLine(stage, detail);
  dom.stages.append(line);
}

bridge.onEvent((event: WorkerEvent) => {
  if (event.type === "status") {
    paint(stageLine(event.stage, event.detail), stageStart.get(event.stage) ?? 0);
    remember(event.stage, event.detail);
  } else if (event.type === "progress") {
    const start = stageStart.get(event.stage) ?? 0;
    const weight = LOADER_STAGES.find((entry) => entry.stage === event.stage)?.weight ?? 0;
    const bytes = event.total
      ? ` — ${Math.round((event.pct ?? 0) * 100)}% of ${(event.total / 1024 / 1024).toFixed(1)} MB`
      : ` — ${(event.loaded / 1024 / 1024).toFixed(1)} MB`;
    paint(bytes.trimStart() || "downloading…", start + weight * (event.pct ?? 0));
  } else if (event.type === "ready") {
    paint(`python ${event.version} ready (pyodide ${event.pyodide})`, 1);
  } else if (event.type === "error") {
    paint(`worker failed: ${event.message}`, shown);
  }
});

// --- boot the app ----------------------------------------------------------------------

type Variant = { key: string; label: string; run: RunResult; kata?: string };
type Mode = "campus" | "watch" | "hand" | "kata";

/** Every level the picker offers. */
const LEVELS = ["level1", "level2", "level3", "level4", "level5", "level6", "level7", "level8", "level9"];
/** Levels played by hand (sandbox / warm-up). */
const HAND_LEVELS = ["level1", "level2"];
/** Levels where you write a kata (Stages 6+). */
const KATA_LEVELS = ["level3", "level4", "level5", "level6", "level7", "level8", "level9"];

let timeline: TimelineHandle | null = null;
let variants: Variant[] = [];
let active = 0;
let levelDuration = 0;
let level: Level = {};
let mode: Mode = "watch";
let hand: HandGame | null = null;
let kata: KataPlayHandle | null = null;

// Hand/kata chrome built at boot (index.html stays untouched).
let hudBox: HTMLElement;
let modePicker: HTMLElement;
let levelPicker: HTMLElement;
let handBadge: HTMLElement;
let handPanel: HTMLElement;
let campusPanel: HTMLElement;
let campusBody: HTMLElement;
let campusStage: HTMLElement;
let campusRail: HTMLElement;
let campusToolbar: HTMLElement | null = null;
const campusVariantButtons = new Map<"live" | "hand", HTMLButtonElement>();
let campusTutorialChip: HTMLButtonElement | null = null;
/** Art 6b chaining: "Next city ▸" (the script ended and its `end.next` names a city). */
let campusNextChip: HTMLButtonElement | null = null;
/** Art 6b: Endless availability — flipped by a script's `endless_unlock`, launched for real by Art 7. */
let campusEndlessChip: HTMLButtonElement | null = null;
/** A scripted booth hand-off that hopped to kata mode; Back to campus returns to the chain. */
let returnCampus = false;
let kataBackChip: HTMLButtonElement | null = null;
let campus: CampusPlay | null = null;
/** Art 4: which campus run is up (live auto vs hand) and whether a city script is attached. */
let campusVariant: "live" | "hand" = "live";
let campusTutorial = false;
/** Art 5: which city script the tutorial chip / `?city=N` boots (`city1` … `city9`). */
let campusCity = "city1";
/** Art 6b: the chained city a finished script points at, pending a "Next city ▸" press. */
let campusNextCity: number | null = null;
let tutorialRunner: TutorialRunner | null = null;
const cityParam = new URLSearchParams(location.search).get("city");
/** `?city=N` (any city): boot straight into that city's scripted hand campus. */
const cityNum = cityParam !== null && /^[1-9]\d*$/.test(cityParam) ? cityParam : null;
let handStage: HTMLElement;
let handGauges: HTMLElement;
let kataPanel: HTMLElement;
let kataStage: HTMLElement;
const modeButtons = new Map<Mode, HTMLButtonElement>();
const levelButtons = new Map<string, HTMLButtonElement>();

// Stage 7: progression HUD + upgrade shop (mounted once at boot).
let hud: HudHandle | null = null;
let shop: ShopHandle | null = null;
/** Tier gates (Stage 9): the level's own unlock tiers (raw, before the owned-union), the tiers the
 * player owns, and their belt — refreshed from progression on load and on every shop change. */
let baseTiers: string[] = ["core"];
let ownedTiers: string[] = [];
let playerBelt: string | undefined;
/** The gated level dict currently mounted in the kata panel (its `unlocks` mutate when the player
 * buys a tier, so the next kata run picks the wider gate up without losing the editor text). */
let activeKataLevel: Level | null = null;
let kataNotice: HTMLElement;
/** A watch run whose completion is pending (recorded shortly after the app paints, so the HUD's
 * first frame shows the pre-run state; deduped per level+seed so reloads never farm credits). */
let pendingWatchRecord: (() => Promise<void>) | null = null;

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, document.baseURI).href);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(new URL(path, document.baseURI).href);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  const prefs = loadStore().prefs;
  const savedMode = prefs.mode as string | undefined;
  mode = savedMode === "hand" || savedMode === "kata" || savedMode === "campus" ? savedMode : "watch";
  if (cityNum !== null) {
    // ?city=N: boot straight into the campus tutorial — hand traffic, script attached.
    mode = "campus";
    campusVariant = "hand";
    campusTutorial = true;
    campusCity = `city${cityNum}`;
  } else if (typeof prefs.city === "number" && prefs.city >= 1 && prefs.city <= 9) {
    // Art 6b: the campaign remembers the city the chain last reached (the chip only — the player
    // still chooses whether to run the script).
    campusCity = `city${prefs.city}`;
  }
  buildChrome();
  mountProgressionChrome();
  await applyDriftOnBoot();
  // Stage 9: a `?c=`/`#c=` link takes priority — boot straight into the card's level, then replay.
  const cardParam = share.shareParam();
  const cardMeta = cardParam ? share.decodeShareCard(cardParam) : null;
  const cardLevel = cardMeta ? share.cardLevelId(cardMeta) : "";
  const start = LEVELS.includes(cardLevel)
    ? cardLevel
    : typeof prefs.level === "string" && LEVELS.includes(prefs.level)
      ? prefs.level
      : "level1";
  await loadLevel(start);
  dom.app.hidden = false;
  dom.loader.hidden = true;
  flushPendingWatchRecord();
  if (cardParam) await replayShareCard(cardParam, cardMeta);
}

function levelId(): string {
  return String(level.id ?? "level1");
}

/** The campaign city the campus is currently showing (city editions keep the canonical level id). */
function cityNumber(): number {
  const m = /^city([1-9])$/.exec(campusCity);
  return m ? Number(m[1]) : 0;
}

/** Create the mode/level pickers, the "hand" badge and the hand/kata panels (before the timeline). */
function buildChrome(): void {
  const header = dom.app.querySelector(".app-header") ?? dom.app;
  const controls = document.createElement("div");
  controls.className = "mode-level-pickers";
  levelPicker = document.createElement("div");
  levelPicker.className = "run-picker";
  levelPicker.setAttribute("role", "group");
  levelPicker.setAttribute("aria-label", "Levels");
  modePicker = document.createElement("div");
  modePicker.className = "run-picker";
  modePicker.setAttribute("role", "group");
  modePicker.setAttribute("aria-label", "Play mode");
  controls.append(levelPicker, modePicker);
  header.append(controls);

  for (const id of LEVELS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = id.replace("level", "Level ");
    button.addEventListener("click", () => void setLevel(id).catch(fail));
    levelPicker.append(button);
    levelButtons.set(id, button);
  }
  for (const [key, text] of [
    ["campus", "Campus (live)"],
    ["watch", "Watch (auto)"],
    ["hand", "Play by hand"],
    ["kata", "Write a kata"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", () => void setMode(key).catch(fail));
    modePicker.append(button);
    modeButtons.set(key, button);
  }

  handBadge = document.createElement("span");
  handBadge.className = "hand-badge";
  handBadge.textContent = "hand";
  handBadge.title = "hand mode — you place the jobs";
  handBadge.hidden = true;
  (dom.title.parentElement ?? dom.title).append(handBadge);

  hudBox = document.createElement("div");
  hudBox.className = "hud-slot";
  hudBox.setAttribute("role", "group");
  hudBox.setAttribute("aria-label", "Player progress");
  header.append(hudBox);

  handPanel = document.createElement("section");
  handPanel.className = "panel";
  handPanel.hidden = true;
  const heading = document.createElement("h2");
  heading.textContent = "Play by hand";
  heading.id = "hand-heading";
  handPanel.setAttribute("aria-labelledby", "hand-heading");
  handGauges = document.createElement("div");
  handGauges.setAttribute("role", "group");
  handGauges.setAttribute("aria-label", "Live cluster gauges");
  handStage = document.createElement("div");
  handPanel.append(heading, handGauges, handStage);
  const timelinePanel = dom.timeline.closest(".panel") ?? dom.timeline;
  dom.app.insertBefore(handPanel, timelinePanel);

  campusPanel = document.createElement("section");
  campusPanel.className = "panel";
  campusPanel.hidden = true;
  const campusHeading = document.createElement("h2");
  campusHeading.textContent = "Campus";
  campusHeading.id = "campus-heading";
  campusPanel.setAttribute("aria-labelledby", "campus-heading");
  campusBody = document.createElement("div");
  campusBody.className = "campus-body";
  campusStage = document.createElement("div");
  campusStage.className = "campus-stage";
  // Art 6b: the right rail — the fairness share meters live here (`CampusPlayOptions.rail`). It is
  // `hidden` whenever there is nothing to pin, so the canvas keeps its full width (and the visual
  // harness, which never gets a rail, keeps its exact geometry).
  campusRail = document.createElement("div");
  campusRail.className = "campus-rail";
  campusRail.setAttribute("role", "group");
  campusRail.setAttribute("aria-label", "Campus meters");
  campusRail.hidden = true;
  campusBody.append(campusStage, campusRail);
  campusPanel.append(campusHeading, campusBody);
  dom.app.insertBefore(campusPanel, timelinePanel);

  kataPanel = document.createElement("section");
  kataPanel.className = "panel";
  kataPanel.hidden = true;
  const kataHeading = document.createElement("h2");
  kataHeading.textContent = "Write a kata";
  kataHeading.id = "kata-heading";
  kataPanel.setAttribute("aria-labelledby", "kata-heading");
  kataNotice = document.createElement("div");
  kataNotice.className = "kata-notice";
  kataNotice.hidden = true;
  kataNotice.setAttribute("role", "status");
  kataNotice.setAttribute("aria-live", "polite");
  kataStage = document.createElement("div");
  kataPanel.append(kataHeading, kataNotice, kataStage);
  // Art 6b: a mid-chain booth hand-off out of a HAND city (1-2) must not lose the campaign — this
  // chip gets the player back onto the campus (same city script, re-attached from its top).
  kataBackChip = document.createElement("button");
  kataBackChip.type = "button";
  kataBackChip.className = "campus-tutorial-chip kata-back-chip";
  kataBackChip.textContent = "\u25c0 Back to campus";
  kataBackChip.title = "return to the city you came from (its tutorial script restarts)";
  kataBackChip.hidden = true;
  kataBackChip.addEventListener("click", () => {
    returnCampus = false;
    kataBackChip!.hidden = true;
    void setMode("campus").catch(fail);
  });
  kataPanel.insertBefore(kataBackChip, kataHeading);
  dom.app.insertBefore(kataPanel, timelinePanel);
}

/** Mount the HUD + shop once, then run the offline-drift "welcome back" once per boot. */
function mountProgressionChrome(): void {
  shop = mountShop({
    onChange: () => {
      void hud?.refresh().catch(fail);
      void applyProgressionUnlocks().catch(fail); // freshly bought tiers widen the kata unlocks
    },
  });
  hud = mountHud(hudBox, { onOpenShop: () => shop?.open() });
}

/** Offline drift on load: award idle credits (engine-capped) and toast a subtle welcome back. */
async function applyDriftOnBoot(): Promise<void> {
  const firstBoot = progression.getProgression() === null;
  const { award } = await progression.drift();
  if (!firstBoot && award > 0) hud?.announce(`welcome back +${award} credits`);
  await hud?.refresh().catch(fail);
}

/** Level unlocks the player has earned: the level's own tiers ∪ the upgrades they own (this stays
 * the watch/hand view); kata runs additionally gate to owned ∩ level via `gatedKataLevel`. */
async function applyProgressionUnlocks(): Promise<void> {
  const view = await progression.view();
  ownedTiers = view.unlocked;
  playerBelt = view.belt;
  level.unlocks = [...new Set([...baseTiers, ...ownedTiers])].sort();
  if (activeKataLevel) {
    activeKataLevel.unlocks = gatedKataLevel().unlocks; // widen the mounted kata's gate in place
    paintKataNotice();
  }
}

/** Display names for the tiers a level can require (kata spec §6 tiers). */
const TIER_NAMES: Record<string, string> = {
  core: "Core",
  reserve: "Reservations",
  sensor: "Sensors",
  fairness: "Fairness",
  preempt: "Preemption",
  route: "Data routing",
};

/** `level` gated for kata play: ["core"] ∪ (owned upgrades ∩ the level's own unlock tiers). */
function gatedKataLevel(): Level {
  const owned = ownedTiers.filter((tier) => baseTiers.includes(tier));
  return { ...level, unlocks: [...new Set(["core", ...owned])] };
}

/** A gentle "…is locked — buy it in Upgrades" notice when the kata level needs an unbought tier. */
function paintKataNotice(): void {
  const missing = baseTiers.filter((tier) => tier !== "core" && !ownedTiers.includes(tier));
  kataNotice.textContent = "";
  kataNotice.hidden = missing.length === 0;
  if (!missing.length) return;
  const names = missing.map((tier) => TIER_NAMES[tier] ?? tier).join(" · ");
  const text = document.createElement("span");
  text.textContent = `${names} ${missing.length === 1 ? "is" : "are"} locked — buy ${missing.length === 1 ? "it" : "them"} in Upgrades`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Open shop";
  button.addEventListener("click", () => shop?.open());
  kataNotice.append(text, button);
}

/** Record the pending watch-run completion (once) a beat after the app became visible. */
function flushPendingWatchRecord(): void {
  const record = pendingWatchRecord;
  pendingWatchRecord = null;
  if (record) window.setTimeout(() => void record().catch(fail), 3000);
}

/** Per-run record for `recordCompletion` (a city edition scores against its own level id). */
async function recordCompletion(run: RunResult, dedupeBySeed: boolean, id = levelId()): Promise<void> {
  try {
    if (dedupeBySeed && progression.hasPass(id, run.seed)) return;
    await progression.complete(id, run.score ?? 0, run.seed);
    await hud?.refresh();
  } catch (error) {
    console.warn("progression completion failed", error);
  }
}

/** Is a mode available for the level currently loaded? */
function modeAllowed(m: Mode): boolean {
  // Campus play is not level-bound (hand cities 1-2 and the scripted cities included).
  if (m === "watch" || m === "campus") return true;
  if (m === "hand") return HAND_LEVELS.includes(levelId());
  return KATA_LEVELS.includes(levelId());
}

function paintControls(): void {
  for (const [key, button] of modeButtons) {
    button.setAttribute("aria-pressed", String(key === mode));
    button.hidden = !modeAllowed(key);
  }
  for (const [id, button] of levelButtons) button.setAttribute("aria-pressed", String(id === levelId()));
  handBadge.hidden = mode !== "hand";
  handPanel.hidden = mode !== "hand";
  kataPanel.hidden = mode !== "kata";
  campusPanel.hidden = mode !== "campus";
  dom.picker.hidden = mode !== "watch";
}

async function loadLevel(id: string): Promise<void> {
  level = await fetchJson<Level>(`levels/${id}.json`);
  baseTiers = Array.isArray(level.unlocks) ? [...(level.unlocks as string[])] : ["core"];
  activeKataLevel = null;
  await applyProgressionUnlocks().catch(() => undefined); // owned upgrades gate kata tiers
  levelDuration = Number(level.duration ?? 0);
  dom.title.textContent = String(level.title ?? level.id ?? "Level");
  dom.story.textContent = String(level.story ?? "");
  if (!modeAllowed(mode)) mode = "watch";
  destroyModes();
  timeline?.destroy();
  timeline = null;
  variants = [];
  dom.readout.replaceChildren();
  if (mode === "hand") await enterHand();
  else if (mode === "kata") await enterKata();
  else if (mode === "campus") await enterCampus();
  else await enterWatch();
  paintControls();
}

async function setMode(next: Mode): Promise<void> {
  if (next === mode || !modeAllowed(next)) return;
  mode = next;
  saveStore({ prefs: { mode: mode as "watch" } });
  destroyModes();
  timeline?.destroy();
  timeline = null;
  variants = [];
  dom.readout.replaceChildren();
  if (next === "hand") await enterHand();
  else if (next === "kata") await enterKata();
  else if (next === "campus") await enterCampus();
  else await enterWatch();
  paintControls();
  flushPendingWatchRecord();
}

async function setLevel(id: string): Promise<void> {
  if (id === levelId()) return;
  saveStore({ prefs: { level: id } });
  await loadLevel(id);
  flushPendingWatchRecord();
}

function destroyModes(): void {
  hand?.destroy();
  hand = null;
  handStage.textContent = "";
  handGauges.textContent = "";
  tutorialRunner?.destroy();
  tutorialRunner = null;
  campus?.destroy();
  campus = null;
  campusStage.textContent = "";
  campusRail.textContent = "";
  campusRail.hidden = true;
  kata?.destroy();
  kata = null;
  activeKataLevel = null;
  kataStage.textContent = "";
  if (kataNotice) kataNotice.hidden = true;
}

/** Existing behaviour: run the level under its default policy + the reference kata. */
async function enterWatch(): Promise<void> {
  paint(`running ${levelId()} (auto)…`, 1);

  const baseline = await bridge.runLevel(level, {
    policy: String(level.default_policy ?? "idle"),
  });

  variants = [{ key: "idle", label: `policy: ${baseline.policy}`, run: baseline }];

  const kataPath = typeof level.reference_kata === "string" ? level.reference_kata : null;
  if (kataPath) {
    const kata = await fetchText(`levels/${kataPath}`);
    const report = await bridge.checkKata(kata);
    if (!report.ok) throw new Error(`reference kata invalid: ${formatKataErrors(report.errors)}`);
    const reference = await bridge.runLevel(level, { policy: "kata", kata });
    variants.push({ key: "kata", label: "reference kata", run: reference, kata });
  }

  dom.picker.replaceChildren(
    ...variants.map((variant, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = variant.label;
      button.addEventListener("click", () => show(index));
      return button;
    }),
  );
  // Prefer the kata run as the opening view: an idle run has nothing on the lanes but ticks.
  const opening = variants.findIndex((variant) => variant.key === "kata") > 0 ? variants.length - 1 : 0;
  show(opening);
  // A watch run "completes" the level once per seed (engine-tracked `passes` dedupe: page reloads
  // never farm credits from automatic runs). Recorded after the app paints; see flushPending.
  const watchRun = variants[opening]!.run;
  pendingWatchRecord = async () => {
    if (!progression.hasPass(levelId(), watchRun.seed)) await recordCompletion(watchRun, true);
  };
}

/**
 * Campus mode (phase two): the present-tense view. Art 4 adds the run variants *inside* the
 * campus stage (not a 5th top-level mode): "Campus (live)" is the Art 3 auto-stepping engine
 * view; "Campus (hand)" is hand traffic through `hand_start`/`hand_place`/`hand_tick`; and the
 * "Tutorial: city 1" chip (shown while the belt is Orange or below, or via `?city=1`) restarts
 * the hand run on the city-1 *edition* of the level with the tutorial runner attached.
 */
async function enterCampus(): Promise<void> {
  dom.picker.textContent = "";
  buildCampusToolbar();
  await startCampusRun();
}

function buildCampusToolbar(): void {
  campusToolbar?.remove();
  campusVariantButtons.clear();
  campusTutorialChip = null;
  campusNextChip = null;
  campusEndlessChip = null;
  campusToolbar = document.createElement("div");
  campusToolbar.className = "campus-variant-bar";
  campusToolbar.setAttribute("role", "group");
  campusToolbar.setAttribute("aria-label", "Campus run variant");
  for (const [variant, text] of [["live", "Campus (live)"], ["hand", "Campus (hand)"]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", () => {
      if (campusVariant === variant && campus) return;
      campusVariant = variant;
      void startCampusRun().catch(fail);
    });
    campusToolbar.append(button);
    campusVariantButtons.set(variant, button);
  }
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "campus-tutorial-chip";
  chip.textContent = `Tutorial: ${campusCity.replace("city", "city ")}`;
  chip.addEventListener("click", () => {
    campusTutorial = !campusTutorial;
    if (campusTutorial) campusVariant = "hand"; // the script drives hand traffic
    void startCampusRun().catch(fail);
  });
  campusToolbar.append(chip);
  campusTutorialChip = chip;
  campusToolbar.append(buildNextCityChip(), buildEndlessChip());
  campusPanel.insertBefore(campusToolbar, campusBody);
  void paintCampusToolbar().catch(() => undefined);
}

/** Art 6b "Next city ▸": hidden until a script ends with `end.next` — the chain needs no picker. */
function buildNextCityChip(): HTMLButtonElement {
  const next = document.createElement("button");
  next.type = "button";
  next.className = "campus-tutorial-chip campus-next-chip";
  next.title = "the campaign chain: this city's script ends by handing you the next city";
  next.hidden = true;
  next.addEventListener("click", () => {
    if (campusNextCity === null) return;
    const nextCity = campusNextCity;
    campusNextCity = null;
    next.hidden = true;
    campusCity = `city${nextCity}`;
    campusTutorial = true;
    campusVariant = "hand";
    saveStore({ prefs: { mode: "campus" as "watch", city: nextCity } });
    void startCampusRun().catch(fail);
  });
  campusNextChip = next;
  return next;
}

/** Art 6b: Endless availability (flipped by `endless_unlock`; the mode itself is Art 7). */
function buildEndlessChip(): HTMLButtonElement {
  const endless = document.createElement("button");
  endless.type = "button";
  endless.className = "campus-tutorial-chip campus-endless-chip";
  endless.title = "unlocked by city 3 — the growing city itself arrives with Art 7";
  endless.disabled = true;
  endless.addEventListener("click", () => paint("endless: unlocked, launching in Art 7", shown));
  campusEndlessChip = endless;
  return endless;
}

/** A city script finished (Art 6b): offer the chain, and flip Endless availability when earned. */
function onScriptEnd(ending: TutorialEnding): void {
  if (ending.endlessUnlock) {
    saveStore({ prefs: { endlessUnlocked: true } });
    void paintCampusToolbar().catch(() => undefined);
    paint("endless unlocked — the growing city arrives with Art 7", 0);
  }
  if (ending.completed && ending.next !== null && ending.next >= 1 && ending.next <= 9) {
    campusNextCity = ending.next;
    if (!campusNextChip) return;
    campusNextChip.textContent = `Next city \u25b8 (${ending.next})`;
    campusNextChip.hidden = false;
    campusNextChip.focus?.();
    paint(`city ${ending.city} done \u2014 \u25b8 next city in the toolbar`, 0);
    return;
  }
  if (campusNextChip) { campusNextChip.hidden = true; campusNextCity = null; }
}

/** Live/Hand pressed states + chip visibility (belt ≤ Orange, or `?city=N` forcing it on). */
async function paintCampusToolbar(): Promise<void> {
  for (const [variant, button] of campusVariantButtons) {
    button.setAttribute("aria-pressed", String(campusVariant === variant));
  }
  if (campusTutorialChip) {
    campusTutorialChip.textContent = `Tutorial: ${campusCity.replace("city", "city ")}`;
  }
  if (cityNum !== null) campusTutorial = true;
  let belt = playerBelt;
  if (belt === undefined) belt = (await progression.view()).belt;
  const early = ["white", "yellow", "orange"].includes(String(belt).toLowerCase());
  if (campusTutorialChip) {
    campusTutorialChip.hidden = !(early || cityNum !== null);
    campusTutorialChip.setAttribute("aria-pressed", String(campusTutorial));
  }
  if (!campusEndlessChip) return;
  // Available once a script granted it, or once the campaign is past city 3 (the hand-off path
  // into a script never runs `onEnd` for the city that unlocked it).
  const unlocked = loadStore().prefs.endlessUnlocked === true || cityNumber() > 3;
  campusEndlessChip.textContent = unlocked ? "Endless ▸ (Art 7)" : "Endless ▸ (locked)";
  campusEndlessChip.setAttribute("aria-disabled", String(!unlocked));
}

/** (Re)start the campus run for the current variant, patching in the city edition when scripted. */
async function startCampusRun(): Promise<void> {
  tutorialRunner?.destroy();
  tutorialRunner = null;
  campus?.destroy();
  campus = null;
  campusStage.textContent = "";
  campusRail.textContent = "";
  campusRail.hidden = true;
  if (campusNextChip) campusNextChip.hidden = true;
  campusNextCity = null;
  await paintCampusToolbar().catch(() => undefined);
  let runLevel = level;
  let ruleCardsSource: string | undefined;
  if (campusTutorial) {
    const edition = await cityLevel(campusCity).catch((error: unknown) => {
      console.warn(`tutorial ${campusCity} city level failed`, error);
      return null;
    });
    if (edition) runLevel = edition.level;
  }
  if (campusVariant === "hand") {
    const reference = typeof runLevel.reference_kata === "string" ? String(runLevel.reference_kata) : null;
    if (reference) ruleCardsSource = await fetchText(`levels/${reference}`).catch(() => undefined);
  }
  campus = await CampusPlay.create({
    level: runLevel,
    container: campusStage,
    rail: campusRail,
    mode: campusVariant,
    reducedMotion: reduceMotion,
    ruleCardsSource,
    // Art 5: the booth's "Open the full editor" hands its serialization to the kata editor.
    onOpenEditor: (kata) => { void handoffToKata(kata).catch(fail); },
    onFinish: (run) => {
      renderReadout({ key: "campus", label: "campus", run });
      // A city edition's run records against the edition's level (`level6`), not the level the
      // picker last happened to load — the chain never touches the picker.
      void recordCompletion(run, true, String(run.level_id || levelId())).catch(fail);
    },
    onStatus: (text) => paint(text, 0),
  });
  if (campusVariant === "hand" && campusTutorial) {
    tutorialRunner = await TutorialRunner.start(campusCity, campus, {
      onStatus: (text) => paint(text, 0),
      onEnd: onScriptEnd,
    });
  }
}

/**
 * Art 5 editor hand-off: persist the booth's serialization (the kata editor preselects it via
 * `getBoothChoice` → `KataPlayOptions.initialKata`) and switch app mode to the editor. A level
 * that is hand-only (levels 1-2) cannot host kata mode, so the hand-off hops to the first kata
 * level — the player's cards carry over, the level they were watching does not (city 3 scripts
 * the guided version of this beat).
 */
async function handoffToKata(kata: string): Promise<void> {
  saveBoothChoice("booth cards", kata);
  if (modeAllowed("kata")) {
    await setMode("kata");
    return;
  }
  mode = "kata";
  saveStore({ prefs: { mode: mode as "watch" } });
  returnCampus = true; // city 1/2 hand-offs are mid-chain: offer "Back to campus" (Art 6b)
  await setLevel("level3"); // loads under kata mode (allowed there) and saves the prefs
}

/** Hand mode: mount the HandGame controller (it mounts the gauges itself). */
async function enterHand(): Promise<void> {
  dom.picker.textContent = "";
  renderHandReadout();
  hand = await HandGame.create({
    level,
    container: handStage,
    gauges: handGauges,
    timeline: dom.timeline,
    onFinished: (run) => {
      // renderReadout already appends the persisted-best line for hand runs.
      renderReadout({ key: "hand", label: "hand", run });
      void recordCompletion(run, false).catch(fail);
    },
  });
}

/** Kata mode (Stage 6+, levels 3-9): mount the write-check-run controller on the *gated* level —
 * kata runs only see tiers the player actually owns; locked tiers get a notice, not a surprise. */
async function enterKata(): Promise<void> {
  dom.picker.textContent = "";
  if (kataBackChip) kataBackChip.hidden = !returnCampus;
  activeKataLevel = gatedKataLevel();
  paintKataNotice();
  kata = mountKataPlay(kataStage, activeKataLevel, {
    timeline: dom.timeline,
    // Art 4: a kata chosen at the campus booth preselects the editor (the "staff the booth"
    // record — hand mode cannot switch a live run's policy, so the choice lands here).
    initialKata: getBoothChoice()?.text,
    onRun: (run) => {
      renderReadout({ key: "kata", label: "kata", run });
      void recordCompletion(run, false).catch(fail);
    },
  });
}

/** A small line under the readout with the persisted best score / seeds played. */
function renderHandReadout(): void {
  document.getElementById("saved-best")?.remove();
  const progress = levelProgress(levelId());
  const line = document.createElement("div");
  line.className = "hash";
  line.id = "saved-best";
  const seeds = (progress.completed ?? []).length;
  line.textContent =
    progress.best === undefined && !seeds
      ? "no hand runs saved yet for this level"
      : `saved best ${progress.best === undefined ? "—" : progress.best}${progress.gold ? " · gold" : ""} · ${seeds} seed${seeds === 1 ? "" : "s"} played`;
  dom.readout.append(line);
}

/** A player who asked the OS to reduce motion gets no automatic timeline playback. */
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function show(index: number): void {
  const variant = variants[index];
  if (!variant) return;
  active = index;
  [...dom.picker.querySelectorAll("button")].forEach((button, at) =>
    button.setAttribute("aria-pressed", String(at === active)),
  );
  renderReadout(variant);
  timeline?.destroy();
  timeline = mountTimeline(dom.timeline, variant.run, {
    passSeconds: 18,
    horizon: levelDuration || undefined,
    ...(reduceMotion ? { autoplay: false } : {}),
  });
  labelTimelineRegion(dom.timeline, variant);
}

/**
 * ARIA for the canvas timeline (its own module builds the DOM and stays behaviour-only): the canvas
 * becomes an image with a spoken summary, and the controls that carry no visible name (the speed
 * select, the scrub slider) get one. The numeric scorecard in `#readout` is an `aria-live` region
 * and remains the accessible source of truth — the canvas is decoration on top of it.
 */
function labelTimelineRegion(host: HTMLElement, variant: Variant): void {
  const run = variant.run;
  const horizon = run.end_time || run.jobs.reduce((max, job) => Math.max(max, job.submit), 0);
  const canvas = host.querySelector("canvas");
  if (canvas) {
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      `Timeline of ${run.n_jobs} jobs across ${run.nodes.length} node lanes over ${formatTime(horizon)} `
        + `(${variant.label}): utilization ${(run.metrics.utilization * 100).toFixed(1)}%, `
        + `score ${run.score === undefined ? "not scored" : run.score}. Numbers are also listed in the run scorecard.`,
    );
  }
  const scrub = host.querySelector("input[type=range]");
  if (scrub) scrub.setAttribute("aria-label", "Playhead position in seconds");
  const speed = host.querySelector("select");
  if (speed) speed.setAttribute("aria-label", "Playback speed");
}

function renderReadout(variant: Variant): void {
  const { run } = variant;
  const m = run.metrics;
  const queuedForever = run.jobs.filter((job) => job.start === null || job.start === undefined).length;
  // An idle run technically never ends: show the last submission as the horizon instead of 0s.
  const horizon = run.end_time || run.jobs.reduce((max, job) => Math.max(max, job.submit), 0);
  const stats: [string, string][] = [
    ["score", run.score === undefined ? "—" : String(run.score)],
    ["utilization", `${(m.utilization * 100).toFixed(1)}%`],
    ["bounded slowdown", m.bounded_slowdown.toFixed(2)],
    ["wait p95", formatTime(m.wait_p95)],
    ["fairness", m.fairness.toFixed(3)],
    ["jobs", `${run.n_jobs - queuedForever} run / ${run.n_jobs}`],
    ["horizon", formatTime(horizon)],
  ];
  dom.readout.replaceChildren(
    ...stats.map(([label, value]) => {
      const stat = document.createElement("div");
      stat.className = label === "score" ? "stat score" : "stat";
      const b = document.createElement("b");
      b.textContent = value;
      const span = document.createElement("span");
      span.textContent = label;
      stat.append(b, span);
      return stat;
    }),
  );
  const hash = document.createElement("div");
  hash.className = "hash";
  hash.textContent = `${run.trajectory_hash} · seed ${run.seed} · ${run.policy}`;
  dom.readout.append(hash);
  if (run.bars) {
    const bars = document.createElement("div");
    bars.className = "hash";
    bars.textContent = `pass ${run.bars.pass_score ?? "?"} · gold ${run.bars.gold_score ?? "?"}`;
    dom.readout.append(bars);
  }
  // Stage 9: every finished run (watch / hand / kata) gets a Share button next to its hash.
  const shareRow = document.createElement("div");
  shareRow.className = "share-row";
  dom.readout.append(shareRow);
  share.mountShareButton(shareRow, shareContextFor(variant));
  if (run.policy === "hand") renderHandReadout();
}

/** The card context for a finished run. A hand run cannot be replayed from a seed alone, so its
 * card replays the level's default (auto) policy at the same seed and says so in the tag line. */
function shareContextFor(variant: Variant): share.ShareContext {
  const run = variant.run;
  // A kata run used the *gated* level (owned tiers only) — mint the card from the same dict, so
  // the trajectory the card embeds is exactly the one the player just saw.
  const ctxLevel = run.policy === "kata" && activeKataLevel ? activeKataLevel : level;
  const policy =
    run.policy === "kata"
      ? "kata"
      : run.policy === "hand"
        ? String(level.default_policy ?? "fifo")
        : run.policy;
  const kata =
    run.policy === "kata" ? variant.kata ?? share.currentKataSource(kataStage) ?? undefined : undefined;
  return {
    level: ctxLevel,
    levelId: levelId(),
    title: String(level.title ?? levelId()),
    seed: run.seed,
    policy,
    ...(kata ? { kata } : {}),
    run,
    ...(playerBelt ? { belt: playerBelt } : {}),
    ...(run.policy === "hand" ? { tag: "auto policy at this seed" } : {}),
  };
}

/** Boot-time replay of an incoming `?c=` card: verify Python-side, then re-run + paint + banner. */
async function replayShareCard(payload: string, card: share.DecodedShareCard | null): Promise<void> {
  // Replay under the tier gate the *card* was minted with (its embedded unlocks), so a player
  // without the upgrade replays the stubbed run and one with it replays the full run — the hash
  // check is against the run the card actually promises, not this browser's current unlocks.
  const embedded = card?.level as Level | null | undefined;
  const replayLevel: Level =
    embedded && Array.isArray(embedded.unlocks) ? { ...level, unlocks: embedded.unlocks } : level;
  let ok = false;
  let detail = "";
  try {
    const verdict = await bridge.shareReplay(payload, replayLevel);
    ok = verdict.ok;
    detail = ok
      ? verdict.trajectory_hash.slice(0, 12)
      : `got ${String(verdict.trajectory_hash).slice(0, 8)} ≠ ${String(verdict.expected_hash ?? "?").slice(0, 8)}`;
  } catch (error) {
    detail = error instanceof BridgeError ? `${error.code}: ${error.message}` : String(error);
  }
  if (ok && card) {
    try {
      const run = await bridge.runLevel(replayLevel, {
        seed: card.seed,
        policy: card.kata ? "kata" : card.policy ?? "fifo",
        ...(card.kata ? { kata: String(card.kata) } : {}),
      });
      variants = [{ key: "share", label: "share replay", run, ...(card.kata ? { kata: String(card.kata) } : {}) }];
      show(0);
    } catch (error) {
      ok = false;
      detail = error instanceof BridgeError ? `${error.code}: ${error.message}` : String(error);
    }
  }
  share.showShareBanner(dom.readout, ok, detail);
}

function fail(error: unknown): void {
  const message = error instanceof BridgeError ? `${error.code}: ${error.message}` : String(error);
  paint(`failed: ${message}`, shown);
  const line = document.createElement("li");
  line.className = "error";
  line.textContent = message;
  dom.stages.append(line);
  console.error(error);
}

void main().catch(fail);
