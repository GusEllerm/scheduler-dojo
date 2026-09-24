/**
 * Canvas 2D run timeline: one horizontal lane per node, one colored bar per job interval, a
 * time axis, and a playback cursor that sweeps 0 -> end_time (this is the "level 1 plays back"
 * view). No framework, no DOM charting — a canvas plus two control elements.
 *
 * Colour language: done = green, timeout = amber, unfinished = grey, and a job that is *live at
 * the playhead* = blue.
 *
 * Note on node identity: `bridge.run` returns `nodes` (the cluster) and `jobs` with
 * `nodes: <count>` — a count, not a placement (see bridge.py `_jobs_json`). Lanes are therefore
 * packed deterministically by a first-fit replay of the real start/end times, which is exact in
 * aggregate (node-seconds per lane) though the specific node ids for multi-node jobs may differ
 * from the simulated placement. Pass `placements` (job id -> node ids) to pin the truth.
 */

import type { JobInfo, NodeInfo, RunResult } from "../bridge";

export interface TimelineOptions {
  /** Exact placement override: job id -> node ids it ran on. */
  placements?: Record<string, string[]>;
  /** Wall-clock seconds for a full 1x pass over the run. */
  passSeconds?: number;
  /** Floor for the time axis when a run never ends — a level's `duration`. */
  horizon?: number;
  autoplay?: boolean;
}

export interface TimelineHandle {
  /** Move the playhead (sim seconds) and repaint. */
  seek(t: number): void;
  play(): void;
  pause(): void;
  destroy(): void;
}

const COLORS = {
  bg: "#11151c",
  lane: "#171d26",
  laneAlt: "#141a22",
  grid: "#27303e",
  axis: "#4b5769",
  text: "#c3ccd9",
  dim: "#8894a6",
  cursor: "#f2f5f9",
  done: "#38b17a",
  timeout: "#e5a53c",
  unfinished: "#6b7686",
  running: "#4f8ff7",
} as const;

const GUTTER = 74;
const LANE_H = 26;
const LANE_GAP = 4;
const AXIS_H = 26;
const PAD_TOP = 10;
const PAD_RIGHT = 14;

const STATE_COLOR: Record<JobInfo["state"], string> = {
  done: COLORS.done,
  timeout: COLORS.timeout,
  unfinished: COLORS.unfinished,
};

interface Segment {
  jobId: string;
  nodeId: string;
  start: number;
  end: number;
  state: JobInfo["state"];
  user: string;
}

export function mountTimeline(
  container: HTMLElement,
  run: RunResult,
  options: TimelineOptions = {},
): TimelineHandle {
  const nodes = run.nodes ?? [];
  const jobs = run.jobs ?? [];
  const started = jobs.filter((job) => job.start !== null && job.start !== undefined);
  const lastJobTime = jobs.reduce((max, j) => Math.max(max, j.end ?? j.start ?? j.submit ?? 0), 0);
  // A run that schedules nothing (`policy: "idle"`) reports end_time 0, so the axis is built from
  // the submissions themselves — padded a little and capped by the level duration.
  const horizon = started.length
    ? Math.max(1, run.end_time || 0, lastJobTime)
    : Math.max(1, Math.min(options.horizon ?? lastJobTime * 1.25, lastJobTime * 1.25));
  // Jobs that never started get their own strip, otherwise an idle run looks identical to an
  // empty cluster.
  const queued = jobs.filter((job) => job.start === null || job.start === undefined);

  const segments = layoutSegments(nodes, jobs, options.placements);
  const laneOf = new Map(nodes.map((node, index) => [node.id, index]));
  const laneCount = nodes.length + (queued.length ? 1 : 0);

  // --- DOM ---------------------------------------------------------------------
  container.classList.add("dojo-timeline");
  container.textContent = "";
  const controls = el("div", "dojo-tl-controls", container);
  const playButton = el("button", "dojo-tl-play", controls);
  playButton.type = "button";
  const speed = el("select", "dojo-tl-speed", controls);
  for (const value of ["0.5", "1", "2", "4", "8"]) {
    const option = el("option", "", speed);
    option.value = value;
    option.textContent = `${value}x`;
    option.selected = value === "1";
  }
  const scrub = el("input", "dojo-tl-scrub", controls);
  scrub.type = "range";
  scrub.min = "0";
  scrub.max = String(horizon);
  scrub.step = "1";
  let dragging = false;
  scrub.addEventListener("pointerdown", () => {
    dragging = true;
  });
  window.addEventListener("pointerup", () => {
    dragging = false;
  });
  const clock = el("span", "dojo-tl-clock", controls);
  const legend = el("div", "dojo-tl-legend", controls);
  for (const [label, color] of [
    ["done", COLORS.done],
    ["timeout", COLORS.timeout],
    ["running", COLORS.running],
    ["unfinished", COLORS.unfinished],
  ] as const) {
    const chip = el("span", "dojo-tl-chip", legend);
    const swatch = el("i", "", chip);
    swatch.style.background = color;
    chip.append(document.createTextNode(label));
  }

  const canvas = document.createElement("canvas");
  canvas.className = "dojo-tl-canvas";
  container.append(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");

  const height = PAD_TOP + laneCount * (LANE_H + LANE_GAP) + AXIS_H;
  let width = Math.max(320, container.clientWidth || 640);
  const dpr = window.devicePixelRatio || 1;

  // --- playback state ----------------------------------------------------------
  let cursor = 0;
  let playing = false;
  let raf = 0;
  let last = 0;
  const passSeconds = options.passSeconds ?? 18;

  playButton.addEventListener("click", () => (playing ? pause() : play()));
  scrub.addEventListener("input", () => {
    seek(Number(scrub.value));
  });

  function resize(): void {
    width = Math.max(320, container.clientWidth || width);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    draw();
  }

  function x(t: number): number {
    return GUTTER + (t / horizon) * (width - GUTTER - PAD_RIGHT);
  }

  function draw(): void {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";

    drawGrid(ctx);
    nodes.forEach((node, index) => drawLane(ctx, node, index));
    drawQueue(ctx);

    // Bars: the part the playhead has passed is opaque in the job's state colour, the future
    // part is dimmed, and a job that is *live* at the cursor is drawn blue from the cursor on.
    for (const seg of segments) {
      const lane = laneOf.get(seg.nodeId);
      if (lane === undefined || seg.end <= seg.start) continue;
      const live = seg.start <= cursor && cursor < seg.end;
      const past = Math.min(seg.end, Math.max(seg.start, cursor));
      if (past > seg.start) drawBar(ctx, seg, lane, STATE_COLOR[seg.state], 1, seg.start, past);
      if (seg.end > past) {
        drawBar(ctx, seg, lane, live ? COLORS.running : STATE_COLOR[seg.state], live ? 1 : 0.32, past, seg.end);
      }
    }

    drawCursor(ctx);
    drawAxis(ctx);
    clock.textContent = `${formatTime(cursor)} / ${formatTime(horizon)}`;
    if (!dragging) scrub.value = String(Math.round(cursor));
  }

  function drawBar(
    c: CanvasRenderingContext2D,
    seg: Segment,
    lane: number,
    color: string,
    alpha: number,
    from: number,
    to: number,
  ): void {
    const y = PAD_TOP + lane * (LANE_H + LANE_GAP);
    const x0 = x(from);
    const x1 = x(to);
    c.globalAlpha = alpha;
    c.fillStyle = color;
    roundRect(c, x0, y + 1, Math.max(1.5, x1 - x0), LANE_H - 2, 3);
    c.globalAlpha = 1;
    if (x1 - x0 > 46) {
      c.fillStyle = "rgba(10,14,20,0.85)";
      c.fillText(seg.jobId, x0 + 5, y + LANE_H / 2);
    }
  }

  function drawQueue(c: CanvasRenderingContext2D): void {
    if (!queued.length) return;
    const y = PAD_TOP + nodes.length * (LANE_H + LANE_GAP);
    c.fillStyle = COLORS.laneAlt;
    roundRect(c, GUTTER, y, width - GUTTER - PAD_RIGHT, LANE_H, 4);
    c.fillStyle = COLORS.dim;
    c.textAlign = "right";
    c.fillText("queued", GUTTER - 8, y + LANE_H / 2);
    c.textAlign = "left";
    for (const job of queued) {
      // A tick at the submit time: queued forever under an idle scheduler, started later otherwise.
      c.globalAlpha = job.submit <= cursor ? 0.9 : 0.3;
      c.fillStyle = COLORS.unfinished;
      roundRect(c, x(job.submit), y + 5, 3, LANE_H - 10, 1.5);
      c.globalAlpha = 1;
    }
  }

  function drawGrid(c: CanvasRenderingContext2D): void {
    c.strokeStyle = COLORS.grid;
    c.lineWidth = 1;
    nodes.forEach((_, index) => {
      const y = PAD_TOP + index * (LANE_H + LANE_GAP) + LANE_H + LANE_GAP / 2;
      c.beginPath();
      c.moveTo(GUTTER, y + 0.5);
      c.lineTo(width - PAD_RIGHT, y + 0.5);
      c.stroke();
    });
  }

  function drawLane(c: CanvasRenderingContext2D, node: NodeInfo, index: number): void {
    const y = PAD_TOP + index * (LANE_H + LANE_GAP);
    c.fillStyle = index % 2 ? COLORS.laneAlt : COLORS.lane;
    roundRect(c, GUTTER, y, width - GUTTER - PAD_RIGHT, LANE_H, 4);
    c.fillStyle = COLORS.dim;
    c.textAlign = "right";
    c.fillText(nodeLabel(node), GUTTER - 8, y + LANE_H / 2);
    c.textAlign = "left";
  }

  function drawAxis(c: CanvasRenderingContext2D): void {
    const y = height - AXIS_H + 6;
    c.strokeStyle = COLORS.axis;
    c.beginPath();
    c.moveTo(GUTTER, y + 0.5);
    c.lineTo(width - PAD_RIGHT, y + 0.5);
    c.stroke();
    c.fillStyle = COLORS.dim;
    c.textAlign = "center";
    const ticks = Math.max(2, Math.floor((width - GUTTER - PAD_RIGHT) / 90));
    for (let i = 0; i <= ticks; i++) {
      const t = (horizon * i) / ticks;
      const px = x(t);
      c.beginPath();
      c.moveTo(px + 0.5, y);
      c.lineTo(px + 0.5, y + 4);
      c.stroke();
      c.fillText(formatTime(t), px, y + 14);
    }
    c.textAlign = "left";
  }

  function drawCursor(c: CanvasRenderingContext2D): void {
    const px = x(cursor);
    c.strokeStyle = COLORS.cursor;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(px + 0.5, PAD_TOP - 6);
    c.lineTo(px + 0.5, height - AXIS_H + 6);
    c.stroke();
    c.lineWidth = 1;
    c.fillStyle = COLORS.cursor;
    c.beginPath();
    c.moveTo(px, PAD_TOP - 7);
    c.lineTo(px - 4, PAD_TOP - 14);
    c.lineTo(px + 4, PAD_TOP - 14);
    c.closePath();
    c.fill();
  }

  function tick(now: number): void {
    if (!playing) return;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    const rate = (horizon / passSeconds) * Number(speed.value || "1");
    cursor = Math.min(horizon, cursor + dt * rate);
    if (cursor >= horizon) pause();
    draw();
    if (playing) raf = requestAnimationFrame(tick);
  }

  function play(): void {
    if (cursor >= horizon) cursor = 0;
    playing = true;
    last = 0;
    playButton.textContent = "Pause";
    raf = requestAnimationFrame(tick);
  }

  function pause(): void {
    playing = false;
    playButton.textContent = "Play";
    cancelAnimationFrame(raf);
    draw();
  }

  function seek(t: number): void {
    cursor = Math.min(horizon, Math.max(0, t));
    draw();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  playButton.textContent = "Play";
  if (options.autoplay !== false) play();

  return {
    seek,
    play,
    pause,
    destroy() {
      pause();
      observer.disconnect();
      container.textContent = "";
    },
  };
}

// --- layout helpers -------------------------------------------------------------------

/** Deterministic first-fit replay of intervals onto lanes (see the module docstring). */
function layoutSegments(
  nodes: NodeInfo[],
  jobs: JobInfo[],
  placements?: Record<string, string[]>,
): Segment[] {
  const segments: Segment[] = [];
  if (!nodes.length) return segments;
  const freeUntil = new Array<number>(nodes.length).fill(0);
  const started = jobs
    .filter((j) => j.start !== null && j.start !== undefined)
    .sort((a, b) => (a.start! - b.start!) || a.id.localeCompare(b.id));

  for (const job of started) {
    const end = job.end ?? job.start!;
    const pinned = placements?.[job.id];
    let chosen: number[] = [];
    if (pinned?.length) {
      chosen = pinned.map((id) => nodes.findIndex((n) => n.id === id)).filter((i) => i >= 0);
    } else {
      const want = Math.max(1, job.nodes || 1);
      for (let i = 0; i < nodes.length && chosen.length < want; i++) {
        if ((freeUntil[i] ?? 0) <= job.start!) chosen.push(i);
      }
      // Never found enough free lanes (a sim placement we cannot replay): fall back to the
      // busiest-free lanes so the interval still shows up rather than vanishing.
      for (let i = 0; i < nodes.length && chosen.length < want; i++) {
        if (!chosen.includes(i)) chosen.push(i);
      }
    }
    for (const lane of chosen) {
      const node = nodes[lane];
      if (!node) continue;
      freeUntil[lane] = end;
      segments.push({
        jobId: job.id,
        nodeId: node.id,
        start: job.start!,
        end,
        state: job.state,
        user: job.user,
      });
    }
  }
  return segments;
}

function nodeLabel(node: NodeInfo): string {
  const parts = [node.name || node.id, `${node.cpus}c`];
  if (node.gpus) parts.push(`${node.gpus}g`);
  return parts.join(" ");
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
  ctx.fill();
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.append(node);
  return node;
}
