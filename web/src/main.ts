/**
 * Page shell: loading screen driven by real worker progress, then a level either played back
 * ("Watch (auto)") under its default policy + reference kata, or played by hand ("Play by hand",
 * Stage 5) with the HandGame controller and live gauges. The timeline renders both.
 */

import "./style.css";
import { bridge, BridgeError, formatKataErrors, type Level, type RunResult } from "./bridge";
import { HandGame } from "./hand";
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
type Mode = "watch" | "hand" | "kata";

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
  mode = savedMode === "hand" || savedMode === "kata" ? savedMode : "watch";
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

/** Create the mode/level pickers, the "hand" badge and the hand/kata panels (before the timeline). */
function buildChrome(): void {
  const header = dom.app.querySelector(".app-header") ?? dom.app;
  const controls = document.createElement("div");
  controls.className = "mode-level-pickers";
  levelPicker = document.createElement("div");
  levelPicker.className = "run-picker";
  modePicker = document.createElement("div");
  modePicker.className = "run-picker";
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
  handBadge.hidden = true;
  (dom.title.parentElement ?? dom.title).append(handBadge);

  hudBox = document.createElement("div");
  hudBox.className = "hud-slot";
  header.append(hudBox);

  handPanel = document.createElement("section");
  handPanel.className = "panel";
  handPanel.hidden = true;
  const heading = document.createElement("h2");
  heading.textContent = "Play by hand";
  handGauges = document.createElement("div");
  handStage = document.createElement("div");
  handPanel.append(heading, handGauges, handStage);
  const timelinePanel = dom.timeline.closest(".panel") ?? dom.timeline;
  dom.app.insertBefore(handPanel, timelinePanel);

  kataPanel = document.createElement("section");
  kataPanel.className = "panel";
  kataPanel.hidden = true;
  const kataHeading = document.createElement("h2");
  kataHeading.textContent = "Write a kata";
  kataNotice = document.createElement("div");
  kataNotice.className = "kata-notice";
  kataNotice.hidden = true;
  kataStage = document.createElement("div");
  kataPanel.append(kataHeading, kataNotice, kataStage);
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

/** Feed a finished run into progression (credits) and repaint the HUD. */
async function recordCompletion(run: RunResult, dedupeBySeed: boolean): Promise<void> {
  try {
    if (dedupeBySeed && progression.hasPass(levelId(), run.seed)) return;
    await progression.complete(levelId(), run.score ?? 0, run.seed);
    await hud?.refresh();
  } catch (error) {
    console.warn("progression completion failed", error);
  }
}

/** Is a mode available for the level currently loaded? */
function modeAllowed(m: Mode): boolean {
  if (m === "watch") return true;
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
  activeKataLevel = gatedKataLevel();
  paintKataNotice();
  kata = mountKataPlay(kataStage, activeKataLevel, {
    timeline: dom.timeline,
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
  });
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
