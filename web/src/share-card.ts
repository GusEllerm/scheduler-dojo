/**
 * Stage 9: the share-card picture. A pure Canvas-2D drawing of a finished run — level title, seed,
 * score, belt, key metrics, a tiny timeline strip (one bar per job, packed into lanes, coloured by
 * user) and the short trajectory hash. No QR: a QR encoder would be a new runtime dependency for a
 * purely decorative element, so the card carries the hash text instead.
 *
 * The canvas is drawn at a fixed 1000x560 so the PNG is identical regardless of the viewport.
 */

import type { JobInfo, Metrics } from "./bridge";
import { formatTime } from "./render/timeline";

export interface ShareCardArt {
  title: string;
  levelId: string;
  seed: number;
  policy: string;
  score?: number;
  belt?: string;
  metrics: Metrics;
  jobs: JobInfo[];
  endTime: number;
  hash: string;
  /** Short tag line (e.g. "auto policy at this seed"). */
  tag?: string;
}

const W = 1000;
const H = 560;
const PAD = 44;
const INK = "#e8edf6";
const MUTED = "#8b96ab";
const ACCENT = "#ffb454";
const CARD_BG = "#111725";
const PANEL_BG = "#1a2333";

const SANS = "'Avenir Next', 'Segoe UI', system-ui, sans-serif";
const MONO = "'SF Mono', 'Cascadia Mono', Menlo, monospace";

/** Deterministic hue for a user name (same palette the timeline legend style implies). */
function userColor(user: string): string {
  let h = 0;
  for (const ch of user) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${(h * 47) % 360} 70% 60%)`;
}

/** Draw the card into `canvas` (canvas.width/height are set here). */
export function drawShareCard(canvas: HTMLCanvasElement, art: ShareCardArt): void {
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  if (!g) return;

  g.fillStyle = CARD_BG;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.lineWidth = 2;
  g.strokeRect(6, 6, W - 12, H - 12);
  const glow = g.createLinearGradient(0, 0, W, 0);
  glow.addColorStop(0, "rgba(255,180,84,0.85)");
  glow.addColorStop(1, "rgba(80,200,255,0.85)");
  g.fillStyle = glow;
  g.fillRect(6, 6, W - 12, 5);

  // --- header ---------------------------------------------------------------------------
  g.fillStyle = MUTED;
  g.font = `13px ${MONO}`;
  g.textBaseline = "alphabetic";
  g.fillText(`${art.levelId.toUpperCase()} · SEED ${art.seed} · ${art.policy.toUpperCase()}`, PAD, 62);

  g.fillStyle = INK;
  g.font = `600 30px ${SANS}`;
  const maxTitle = W - PAD * 2 - 170;
  let title = art.title;
  while (g.measureText(title).width > maxTitle && title.length > 3) title = title.slice(0, -2);
  if (title !== art.title) title = `${title.slice(0, -1)}…`;
  g.fillText(title, PAD, 100);

  // Belt chip, top-right.
  if (art.belt) {
    g.font = `12px ${MONO}`;
    const label = `BELT ${art.belt.toUpperCase()}`;
    const w = g.measureText(label).width + 24;
    g.fillStyle = PANEL_BG;
    roundRect(g, W - PAD - w, 44, w, 26, 13);
    g.fill();
    g.strokeStyle = "rgba(255,180,84,0.55)";
    g.lineWidth = 1;
    roundRect(g, W - PAD - w, 44, w, 26, 13);
    g.stroke();
    g.fillStyle = ACCENT;
    g.fillText(label, W - PAD - w + 12, 61);
  }

  // --- score ---------------------------------------------------------------------------
  g.fillStyle = ACCENT;
  g.font = `700 64px ${SANS}`;
  g.textAlign = "left";
  const scoreText = art.score === undefined ? "—" : String(Math.round(art.score));
  g.fillText(scoreText, PAD, 178);
  g.fillStyle = MUTED;
  g.font = `13px ${MONO}`;
  g.fillText("SCORE", PAD, 198);

  // --- metric grid (right side) ----------------------------------------------------------
  const m: Metrics = art.metrics;
  const ran = art.jobs.filter((j) => j.start !== null).length;
  const stats: [string, string][] = [
    ["utilization", `${(m.utilization * 100).toFixed(1)}%`],
    ["slowdown", m.bounded_slowdown.toFixed(2)],
    ["wait p95", formatTime(m.wait_p95)],
    ["fairness", m.fairness.toFixed(3)],
    ["jobs", `${ran}/${art.jobs.length}`],
    ["horizon", formatTime(art.endTime)],
  ];
  const gridX = 430;
  const cellW = Math.floor((W - PAD - gridX) / 3);
  stats.forEach(([label, value], i) => {
    const cx = gridX + (i % 3) * cellW;
    const cy = 128 + Math.floor(i / 3) * 60;
    g.fillStyle = MUTED;
    g.font = `11px ${MONO}`;
    g.fillText(label.toUpperCase(), cx, cy);
    g.fillStyle = INK;
    g.font = `600 22px ${SANS}`;
    g.fillText(value, cx, cy + 26);
  });

  // --- timeline strip --------------------------------------------------------------------
  const strip = { x: PAD, y: 250, w: W - PAD * 2, h: 210 };
  g.fillStyle = PANEL_BG;
  roundRect(g, strip.x, strip.y, strip.w, strip.h, 10);
  g.fill();
  drawJobStrip(g, art, strip.x + 12, strip.y + 12, strip.w - 24, strip.h - 32);
  g.fillStyle = MUTED;
  g.font = `11px ${MONO}`;
  g.fillText("TIMELINE", strip.x + 12, strip.y + strip.h - 8);
  g.textAlign = "right";
  g.fillText(formatTime(Math.max(art.endTime, 1)), strip.x + strip.w - 12, strip.y + strip.h - 8);
  g.textAlign = "left";

  // --- footer ------------------------------------------------------------------------------
  g.fillStyle = MUTED;
  g.font = `12px ${MONO}`;
  const tag = art.tag ? ` · ${art.tag}` : "";
  g.fillText(`hash ${art.hash.slice(0, 16)}${tag}`, PAD, H - 32);
  g.textAlign = "right";
  g.fillStyle = ACCENT;
  g.fillText("SCHEDULER DOJO", W - PAD, H - 32);
  g.textAlign = "left";
}

/** Greedy interval-packing of jobs into lanes, drawn as coloured bars. */
function drawJobStrip(
  g: CanvasRenderingContext2D,
  art: ShareCardArt,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const placed = art.jobs.filter((j) => j.start !== null);
  if (!placed.length) return;
  const horizon = Math.max(art.endTime, 1, ...placed.map((j) => Math.max(j.end ?? j.start ?? 0, j.submit)));
  const sorted = [...placed].sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.submit - b.submit);
  const laneEnds: number[] = [];
  const LANE_GAP = 3;
  const MAX_LANES = 12;
  const laneH = Math.max(3, Math.floor(h / MAX_LANES) - LANE_GAP);
  for (const job of sorted) {
    const start = job.start as number;
    const end = job.end ?? job.runtime + start;
    let lane = laneEnds.findIndex((free) => free <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = end;
    const row = lane % MAX_LANES;
    const bx = x + (start / horizon) * w;
    const bw = Math.max(1.5, ((end - start) / horizon) * w);
    g.fillStyle = userColor(job.user);
    g.globalAlpha = 0.92;
    g.fillRect(bx, y + row * (laneH + LANE_GAP), bw, laneH);
    g.globalAlpha = 1;
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
