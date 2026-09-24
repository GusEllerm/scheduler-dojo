/**
 * Page shell: loading screen driven by real worker progress, then a level either played back
 * ("Watch (auto)") under its default policy + reference kata, or played by hand ("Play by hand",
 * Stage 5) with the HandGame controller and live gauges. The timeline renders both.
 */

import "./style.css";
import { bridge, BridgeError, type Level, type RunResult } from "./bridge";
import { HandGame } from "./hand";
import { levelProgress, load as loadStore, save as saveStore } from "./persistence";
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

type Variant = { key: string; label: string; run: RunResult };
type Mode = "watch" | "hand";

/** Levels the hand mode is offered for (sandbox / warm-up levels). */
const LEVELS = ["level1", "level2"];

let timeline: TimelineHandle | null = null;
let variants: Variant[] = [];
let active = 0;
let levelDuration = 0;
let level: Level = {};
let mode: Mode = "watch";
let hand: HandGame | null = null;

// Hand chrome built at boot (index.html stays untouched).
let modePicker: HTMLElement;
let levelPicker: HTMLElement;
let handBadge: HTMLElement;
let handPanel: HTMLElement;
let handStage: HTMLElement;
let handGauges: HTMLElement;
const modeButtons = new Map<Mode, HTMLButtonElement>();
const levelButtons = new Map<string, HTMLButtonElement>();

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
  mode = prefs.mode === "hand" ? "hand" : "watch";
  buildChrome();
  const start = typeof prefs.level === "string" && LEVELS.includes(prefs.level) ? prefs.level : "level1";
  await loadLevel(start);
  dom.app.hidden = false;
  dom.loader.hidden = true;
}

function levelId(): string {
  return String(level.id ?? "level1");
}

/** Create the mode/level pickers, the "hand" badge and the hand panel (before the timeline). */
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
}

function paintControls(): void {
  for (const [key, button] of modeButtons) button.setAttribute("aria-pressed", String(key === mode));
  for (const [id, button] of levelButtons) button.setAttribute("aria-pressed", String(id === levelId()));
  handBadge.hidden = mode !== "hand";
  handPanel.hidden = mode !== "hand";
  dom.picker.hidden = mode !== "watch";
}

async function loadLevel(id: string): Promise<void> {
  level = await fetchJson<Level>(`levels/${id}.json`);
  levelDuration = Number(level.duration ?? 0);
  dom.title.textContent = String(level.title ?? level.id ?? "Level");
  dom.story.textContent = String(level.story ?? "");
  destroyHand();
  timeline?.destroy();
  timeline = null;
  variants = [];
  dom.readout.replaceChildren();
  if (mode === "hand") await enterHand();
  else await enterWatch();
  paintControls();
}

async function setMode(next: Mode): Promise<void> {
  if (next === mode) return;
  mode = next;
  saveStore({ prefs: { mode } });
  destroyHand();
  timeline?.destroy();
  timeline = null;
  variants = [];
  dom.readout.replaceChildren();
  if (next === "hand") await enterHand();
  else await enterWatch();
  paintControls();
}

async function setLevel(id: string): Promise<void> {
  if (id === levelId()) return;
  saveStore({ prefs: { level: id } });
  await loadLevel(id);
}

function destroyHand(): void {
  hand?.destroy();
  hand = null;
  handStage.textContent = "";
  handGauges.textContent = "";
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
    if (!report.ok) throw new Error(`reference kata invalid: ${report.errors.join("; ")}`);
    const reference = await bridge.runLevel(level, { policy: "kata", kata });
    variants.push({ key: "kata", label: "reference kata", run: reference });
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
  show(variants.findIndex((variant) => variant.key === "kata") > 0 ? variants.length - 1 : 0);
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
  if (run.policy === "hand") renderHandReadout();
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
