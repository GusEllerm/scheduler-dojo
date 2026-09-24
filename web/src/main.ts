/**
 * Page shell: loading screen driven by real worker progress, then level 1 played back under its
 * default policy (idle) and under the reference kata, rendered by the Canvas timeline.
 */

import "./style.css";
import { bridge, BridgeError, type Level, type RunResult } from "./bridge";
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

// --- boot the demo ---------------------------------------------------------------------

type Variant = { key: string; label: string; run: RunResult };

let timeline: TimelineHandle | null = null;
let variants: Variant[] = [];
let active = 0;
let levelDuration = 0;

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
  const level = await fetchJson<Level>("levels/level1.json");
  levelDuration = Number(level.duration ?? 0);
  paint("running level 1…", 1);

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

  dom.title.textContent = String(level.title ?? level.id ?? "Level");
  dom.story.textContent = String(level.story ?? "");
  dom.app.hidden = false;
  dom.loader.hidden = true;

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
