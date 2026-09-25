// campus-render.ts — the painter for the campus scene (phase two, Mini Motorways look).
//
// Contract: Concepts/Campus.md is the mapping authority, Concepts/Art Direction.md the motion and
// palette rules. Everything drawn here comes from `CampusScene` + the live `--sd-*` CSS tokens;
// the renderer decides nothing and (inside `render`) reads no clock — no `performance.now`, no
// `Math.random`, no timers. The caller owns rAF and passes an interpolation progress.
//
// DETERMINISM / DRAW ORDER (stable, top-to-bottom of the paint pass):
//   1. ground fill + subtle ground grid          6. run bars + staged ghosts + reserved cones
//   2. sun disc on the top strip (ambient)       7. neighbourhoods (shape, label, ring, %-mark)
//   3. road band + dashed centerline             8. dispatch booth
//   4. queued vehicles on the road (ON the band) 9. overflow pulse overlay
//   5. lots + bays (material, wasted hint)
// Art 4 note: the road paints before the vehicles (the Art 3 order buried the queue under the
// opaque band). Same (canvas size, scene, prev, t) ⇒ pixel-identical output — the harness relies
// on it.
//
// Performance stance (~600 vehicles / 64 bays): fills batched per color into shared Path2D,
// zero shadowBlur, at most one cached gradient (the sun), neighbourhood shapes cached per
// (index, radius). No per-frame gradient creation.

import { readTokens } from "./tokens";
import type { CampusScene, Lot } from "./campus";

/* ------------------------------------------------------------------ config -- */

const GRID_STEP = 48;          // ground grid pitch (CSS px)
const NB_PAD = 12;             // ring radius beyond the shape radius
const VEH_UNIT_W = 14;         // one node of vehicle width (clamped to the slot below)
const VEH_GAP = 4;             // min horizontal gap between queued vehicles
const CONE_H = 18;             // reservation cone height
const CONE_W = 26;             // reservation cone base
const RESERVE_SPAN = 600;      // s shown across a cone countdown tick [defensive default]
const LEN_BASE = 8;            // vehicle length px at est=0
const PULSE_MS = 700;          // overflow pulse budget (timed via caller progress, never a clock)

const FONT_LABEL = "11px system-ui, sans-serif";

export interface CampusRenderOpts {
  reducedMotion?: boolean;
}

/* ------------------------------------------------------------------ helpers -- */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** hex (#rgb | #rrggbb) -> rgba() string; anything else passes through untouched. */
function withAlpha(color: string, alpha: number): string {
  const a = clamp(alpha, 0, 1);
  let h = color.trim();
  if (h.startsWith("#")) {
    h = h.slice(1);
    if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
    if (h.length === 6) {
      const n = parseInt(h, 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
    }
  }
  return color;
}

/** hashUser — stable neighbourhood index from a user name. */
function hashUser(user: string): number {
  let h = 0;
  for (let i = 0; i < user.length; i++) h = (h * 31 + user.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Countdown label for cone text: whole units, never wall clock. */
function fmtDur(t: number): string {
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.round(t / 60)}m`;
  return `${(t / 3600).toFixed(1)}h`;
}

function roundRectPath(p: Path2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  p.moveTo(x + rr, y);
  p.lineTo(x + w - rr, y);
  p.arcTo(x + w, y, x + w, y + rr, rr);
  p.lineTo(x + w, y + h - rr);
  p.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  p.lineTo(x + rr, y + h);
  p.arcTo(x, y + h, x, y + h - rr, rr);
  p.lineTo(x, y + rr);
  p.arcTo(x, y, x + rr, y, rr);
  p.closePath();
}

/** Regular polygon (n sides) centered at 0,0; `rot` orients diamonds/triangles point-up. */
function polygonPath(p: Path2D, n: number, r: number, rot: number): void {
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
  }
  p.closePath();
}

/** 12-point star (6 spikes) centered at 0,0. */
function starPath(p: Path2D, r: number): void {
  for (let i = 0; i < 12; i++) {
    const rad = i % 2 === 0 ? r : r * 0.5;
    const a = -Math.PI / 2 + (i * Math.PI) / 6;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
  }
  p.closePath();
}

/** Neighbourhood shape by index: hex, diamond, pentagon, triangle, octagon, star, square, circle. */
function shapePathFor(index: number, r: number): Path2D {
  const p = new Path2D();
  switch (((index % 8) + 8) % 8) {
    case 0: polygonPath(p, 6, r, 0); break;                       // hexagon
    case 1: polygonPath(p, 4, r, -Math.PI / 2); break;            // diamond
    case 2: polygonPath(p, 5, r, -Math.PI / 2); break;            // pentagon
    case 3: polygonPath(p, 3, r, -Math.PI / 2); break;            // triangle
    case 4: polygonPath(p, 8, r, Math.PI / 8); break;             // octagon
    case 5: starPath(p, r); break;                                // star
    case 6: polygonPath(p, 4, r, Math.PI / 4); break;             // square
    default: p.arc(0, 0, r * 0.85, 0, Math.PI * 2); break;         // circle
  }
  return p;
}

/* -------------------------------------------------------------- slot layout -- */

interface VehSlot { x: number; y: number; w: number; len: number; }

/** Deterministic road slots for `queuedOrder`: lanes stacked top->bottom, filled left->right. */
function roadSlots(scene: CampusScene): Map<string, VehSlot> {
  const out = new Map<string, VehSlot>();
  const road = scene.road;
  const laneH = (road.laneH ?? 30) || 30;
  const lanes = Math.max(1, Math.floor(road.h / laneH));
  const ids = scene.queuedOrder;
  const per = Math.max(1, Math.ceil(ids.length / lanes));
  const slot = road.w / Math.max(1, per);
  const byId = new Map(scene.vehicles.map((v) => [v.id, v] as const));
  ids.forEach((id, i) => {
    const v = byId.get(id);
    if (!v) return;                                    // defensive: order references unknown job
    const lane = Math.floor(i / per), col = i % per;
    const w = clamp((v.nodes || 1) * VEH_UNIT_W, 8, slot - VEH_GAP);
    const len = clamp(LEN_BASE + Math.sqrt(Math.max(0, v.est) / 60) * 1.6, 6, laneH - 6);
    out.set(id, {
      x: road.x + col * slot + (slot - w) / 2,
      y: road.y + lane * laneH + (laneH - len) / 2,
      w, len,
    });
  });
  return out;
}

/** Bay rectangles inside their lot grids, keyed by bay id. */
function bayGeom(scene: CampusScene): Map<string, { x: number; y: number; w: number; h: number; lot: Lot | undefined }> {
  const lots = new Map(scene.lots.map((l) => [l.id, l]));
  const out = new Map<string, { x: number; y: number; w: number; h: number; lot: Lot | undefined }>();
  for (const b of scene.bays) {
    const lot = lots.get(b.lot);
    if (!lot || lot.cols <= 0 || lot.rows <= 0) continue;
    const cw = lot.w / lot.cols, ch = lot.h / lot.rows;
    const col = ((b.col % lot.cols) + lot.cols) % lot.cols;   // defensive vs stale indices
    out.set(b.id, { x: lot.x + col * cw + 2, y: lot.y + b.row * ch + 2, w: Math.max(2, cw - 4), h: Math.max(2, ch - 4), lot });
  }
  return out;
}

/* ---------------------------------------------------------------- renderer -- */

export class CampusRenderer {
  private canvas: HTMLCanvasElement | null;
  private ctx: CanvasRenderingContext2D | null;
  private reduced: boolean;
  private w = 0;
  private h = 0;
  private pal = new Map<string, string>();
  private shapes = new Map<string, Path2D>();          // (index,r) cache
  private sunGrad: CanvasGradient | null = null;
  private sunR = 13;

  constructor(canvas: HTMLCanvasElement, opts?: CampusRenderOpts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.reduced = opts?.reducedMotion ?? false;
    this.refreshPalette();
    const dpr = canvas.ownerDocument?.defaultView?.devicePixelRatio ?? 1;
    this.w = canvas.clientWidth || canvas.width / dpr || 1;
    this.h = canvas.clientHeight || canvas.height / dpr || 1;
    this.applySize(this.w, this.h, dpr);
    this.buildSunGradient();
  }

  /** devicePixelRatio-correct canvas backing store; rebuilds the one cached gradient. */
  resize(cssW: number, cssH: number): void {
    const dpr = this.canvas?.ownerDocument?.defaultView?.devicePixelRatio ?? 1;
    this.w = Math.max(1, cssW);
    this.h = Math.max(1, cssH);
    this.applySize(this.w, this.h, dpr);
    this.buildSunGradient();
  }

  private applySize(cssW: number, cssH: number, dpr: number): void {
    const c = this.canvas;
    if (!c) return;
    c.width = Math.max(1, Math.round(cssW * dpr));
    c.height = Math.max(1, Math.round(cssH * dpr));
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  destroy(): void {
    this.shapes.clear();
    this.pal.clear();
    this.sunGrad = null;
    this.ctx = null;
    this.canvas = null;
  }

  /**
   * Paint `scene`. `prev` (optional) + `tAnimMs` (caller-supplied interpolation PROGRESS,
   * 0..1 — the caller's rAF elapsed / moment budget) interpolate vehicle x and ring angle.
   * Under reducedMotion every state is instant: prev and tAnimMs are ignored, the sun is hidden,
   * and the overflow pulse renders as a static full ring.
   */
  render(scene: CampusScene, prev?: CampusScene | null, tAnimMs?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.refreshPalette();
    const p = this.reduced ? 1 : clamp(tAnimMs ?? 1, 0, 1);
    const base = !this.reduced && prev ? prev : null;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    this.drawGround(ctx);
    this.drawSun(ctx, scene);
    this.drawRoad(ctx, scene);          // road FIRST — the queued vehicles park on top of it (Art 4 fix:
    this.drawQueuedVehicles(ctx, scene, base, p); // the old order painted the opaque road over them)
    this.drawLots(ctx, scene);
    this.drawBays(ctx, scene);
    this.drawRunBars(ctx, scene);
    this.drawStaged(ctx, scene);
    this.drawCones(ctx, scene);
    this.drawNeighbourhoods(ctx, scene, base, p);
    this.drawBooth(ctx, scene);
    this.drawOverflowPulse(ctx, scene, base, p);
    ctx.restore();
  }

  /* ------------------------------------------------------------- palette -- */

  private refreshPalette(): void {
    const roles = readTokens();
    const cs = this.canvas?.ownerDocument ? getComputedStyle(this.canvas.ownerDocument.documentElement) : null;
    const extra = (name: string): string => (cs?.getPropertyValue(`--sd-${name}`).trim() ?? "");
    this.pal.clear();
    for (const [k, v] of Object.entries(roles)) this.pal.set(k, v);
    // The generated table only enumerates role tokens; structural colors are read from the live
    // CSS variables. ground2 / road-line / booth-light are NOT in the generated palette (contract
    // gap) — fall back to the nearest defined tokens so we never invent a color.
    for (const n of ["ground", "ink", "ink-soft", "road", "ring-track", "panel", "line",
                     "ground2", "road-line", "booth-light"]) {
      const v = extra(n);
      if (v) this.pal.set(n, v);
    }
  }

  private c(name: string, fallback = ""): string {
    return this.pal.get(name) ?? this.pal.get(fallback) ?? "#000000";
  }

  /** Owner color of a user: the neighbourhood's token when known, else a stable hash bucket. */
  private ownerColor(user: string, scene: CampusScene): string {
    const nb = scene.neighbourhoods.find((n) => n.user === user);
    const idx = nb ? nb.index : hashUser(user) % 8;
    return this.c(`nb-${(idx % 8) + 1}`);
  }

  /* -------------------------------------------------------------- layers -- */

  private drawGround(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = this.c("ground");
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.strokeStyle = withAlpha(this.c("ground2", "line"), 0.16);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = GRID_STEP; x < this.w; x += GRID_STEP) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, this.h); }
    for (let y = GRID_STEP; y < this.h; y += GRID_STEP) { ctx.moveTo(0, y + 0.5); ctx.lineTo(this.w, y + 0.5); }
    ctx.stroke();
  }

  private buildSunGradient(): void {
    if (this.reduced || !this.ctx) { this.sunGrad = null; return; }
    const g = this.ctx.createRadialGradient(0, 0, 1, 0, 0, this.sunR);
    g.addColorStop(0, withAlpha(this.c("gold"), 0.9));
    g.addColorStop(1, withAlpha(this.c("gold"), 0));
    this.sunGrad = g;
  }

  /** Ambient-only sun disc sliding across the top strip with the day position (hidden if reduced). */
  private drawSun(ctx: CanvasRenderingContext2D, scene: CampusScene): void {
    if (this.reduced || !this.sunGrad) return;
    const x = this.w * clamp(scene.sun ?? 0, 0, 1);
    ctx.save();
    ctx.translate(x, 22);
    ctx.fillStyle = this.sunGrad;
    ctx.beginPath();
    ctx.arc(0, 0, this.sunR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.c("gold");
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawRoad(ctx: CanvasRenderingContext2D, scene: CampusScene): void {
    const r = scene.road;
    ctx.fillStyle = this.c("road");
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = withAlpha(this.c("ink-soft"), 0.35);
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    // Dashed centerline. `road-line` is not a generated token (contract gap) — use panel/line.
    ctx.strokeStyle = withAlpha(this.c("road-line", "panel"), 0.9);
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + r.h / 2);
    ctx.lineTo(r.x + r.w, r.y + r.h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Queued vehicles, snapshot order left->right; fill = owner color (muted), chosen gets the
   *  `veh-chosen` outline + static wave-mark. x interpolates from prev under caller progress. */
  private drawQueuedVehicles(ctx: CanvasRenderingContext2D, scene: CampusScene,
                             base: CampusScene | null, p: number): void {
    const cur = roadSlots(scene);
    const prev = base ? roadSlots(base) : null;
    const chosen = scene.chosen;
    // Batch by fill color (max 8 owner colors + chosen states) — one fill() per bucket.
    const byId = new Map(scene.vehicles.map((v) => [v.id, v] as const));
    const buckets = new Map<string, CampusScene["vehicles"]>();
    for (const id of scene.queuedOrder) {
      const v = byId.get(id);
      if (v) { let list = buckets.get(v.user); if (!list) buckets.set(v.user, (list = [])); list.push(v); }
    }
    for (const [user, list] of buckets) {
      ctx.fillStyle = withAlpha(this.ownerColor(user, scene), 0.55);   // queued = muted solid
      const path = new Path2D();
      for (const v of list) {
        const s = cur.get(v.id);
        if (!s) continue;
        const x0 = prev?.get(v.id)?.x ?? s.x;
        roundRectPath(path, lerp(x0, s.x, p), s.y, s.w, s.len, 3);
      }
      ctx.fill(path);
    }
    if (chosen && cur.has(chosen)) {
      const s = cur.get(chosen)!;
      const x0 = prev?.get(chosen)?.x ?? s.x;
      const x = lerp(x0, s.x, p);
      ctx.fillStyle = withAlpha(this.c("veh-chosen"), 0.18);
      const path = new Path2D();
      roundRectPath(path, x, s.y, s.w, s.len, 3);
      ctx.fill(path);
      ctx.strokeStyle = this.c("veh-chosen");
      ctx.lineWidth = 2;
      ctx.stroke(path);
      this.drawWaveMark(ctx, x + s.w / 2, s.y - 3);
    }
    // Hand mode (Art 4): the PLAYER's pick gets the same chosen outline (no wave-mark — nobody
    // was waved in). Undefined/null in live mode, so the baseline frame is untouched.
    const sel = scene.selectedId;
    if (sel && sel !== chosen && cur.has(sel)) {
      const s = cur.get(sel)!;
      const path = new Path2D();
      roundRectPath(path, s.x, s.y, s.w, s.len, 3);
      ctx.strokeStyle = this.c("veh-chosen");
      ctx.lineWidth = 2;
      ctx.stroke(path);
    }
  }

  /** Hand-mode ghost preview: staged bays tinted in the selected vehicle's owner color at low
   *  alpha, edged `ok` when they would fit / `overflow` when they clearly would not. Undefined
   *  `staged` in live mode ⇒ this paints nothing (baseline-safe). */
  private drawStaged(ctx: CanvasRenderingContext2D, scene: CampusScene): void {
    const staged = scene.staged;
    if (!staged || !staged.bays.length) return;
    const geom = bayGeom(scene);
    const path = new Path2D();
    for (const id of staged.bays) {
      const g = geom.get(id);
      if (g) roundRectPath(path, g.x, g.y, g.w, g.h, 3);
    }
    ctx.fillStyle = withAlpha(this.ownerColor(staged.user, scene), 0.4);
    ctx.fill(path);
    ctx.strokeStyle = this.c(staged.fits ? "ok" : "overflow");
    ctx.lineWidth = 2;
    ctx.stroke(path);
  }

  /** Static three-arc wave-mark ("the booth just picked"). Static = deterministic; motion on it
   *  belongs to a future caller-driven moment, not to a renderer timer. */
  private drawWaveMark(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    ctx.strokeStyle = this.c("veh-chosen");
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.8 - i * 0.25;
      ctx.beginPath();
      ctx.arc(cx, cy - 2, 4 + i * 4, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawLots(ctx: CanvasRenderingContext2D, scene: CampusScene): void {
    for (const lot of scene.lots) {
      const path = new Path2D();
      roundRectPath(path, lot.x, lot.y, lot.w, lot.h, 8);
      ctx.fillStyle = this.c(`bay-${lot.material ?? "default"}`, "bay-default");
      ctx.fill(path);
      ctx.strokeStyle = withAlpha(this.c("line"), 0.8);
      ctx.lineWidth = 1;
      ctx.stroke(path);
      ctx.fillStyle = this.c("ink-soft");
      ctx.font = FONT_LABEL;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(String(lot.id ?? "").toUpperCase(), lot.x + 8, lot.y + 13);
    }
  }

  /** Bay fills batched per material color; wasted (empty, nothing wants it) get a low-alpha
   *  `bay-wasted` wash — the game's most important negative space. Thin pattern overlays last. */
  private drawBays(ctx: CanvasRenderingContext2D, scene: CampusScene): void {
    const geom = bayGeom(scene);
    const fills = new Map<string, Path2D>();
    const wasted = new Path2D();
    const hatch = new Path2D();      // gpu: fine diagonal hatch
    const dots = new Path2D();       // himem: dots
    const borders = new Path2D();
    for (const b of scene.bays) {
      const g = geom.get(b.id);
      if (!g) continue;
      const key = b.occupiedBy ? "__occ__"
        : b.reservedFor ? this.c("bay-idle")
        : (b.idle ? "__idle_wasted__" : this.c("bay-idle"));
      let path = fills.get(key);
      if (!path) fills.set(key, (path = new Path2D()));
      if (key === "__occ__" || key === "__idle_wasted__") roundRectPath(path, g.x, g.y, g.w, g.h, 3);
      else roundRectPath(path, g.x, g.y, g.w, g.h, 3);
      if (key === "__idle_wasted__") {
        roundRectPath(wasted, g.x, g.y, g.w, g.h, 3);
        roundRectPath(borders, g.x, g.y, g.w, g.h, 3);
      }
      if (b.material === "gpu") {
        for (let k = -g.h; k < g.w; k += 6) { hatch.moveTo(g.x + k, g.y + g.h); hatch.lineTo(g.x + k + g.h, g.y); }
      } else if (b.material === "himem") {
        for (let dy = 5; dy < g.h; dy += 7) for (let dx = 5; dx < g.w; dx += 7) {
          dots.moveTo(g.x + dx + 1.1, g.y + dy);
          dots.arc(g.x + dx, g.y + dy, 1.1, 0, Math.PI * 2);
        }
      }
    }
    for (const [key, path] of fills) {
      ctx.fillStyle = key === "__occ__" ? this.c("bay-idle")          // owner run-bar paints over
        : key === "__idle_wasted__" ? this.c("bay-idle")
        : key;                                                        // already a color string
      ctx.fill(path);
    }
    ctx.fillStyle = withAlpha(this.c("bay-wasted"), 0.14);
    ctx.fill(wasted);
    ctx.strokeStyle = withAlpha(this.c("ink-soft"), 0.25);
    ctx.lineWidth = 1;
    ctx.stroke(hatch);
    ctx.fillStyle = withAlpha(this.c("ink-soft"), 0.3);
    ctx.fill(dots);
    ctx.strokeStyle = withAlpha(this.c("line"), 0.5);
    ctx.stroke(borders);
  }

  /** Parked vehicles: one bar across the k bays of a running job, owner color, remaining-time
   *  tick at (end-now)/est. Grouped by job id — deterministic first-bay order. */
  private drawRunBars(ctx: CanvasRenderingContext2D, scene: CampusScene): void {
    const geom = bayGeom(scene);
    const byId = new Map(scene.vehicles.map((v) => [v.id, v] as const));
    const groups = new Map<string, { x: number; y: number; r: number; b: number; user: string }>();
    for (const b of scene.bays) {
      if (!b.occupiedBy) continue;
      const g = geom.get(b.id);
      if (!g || !g.lot) continue;
      const veh = byId.get(b.occupiedBy);
      const prev = groups.get(b.occupiedBy);
      if (!prev) groups.set(b.occupiedBy, { x: g.x, y: g.y, r: g.x + g.w, b: g.y + g.h, user: veh?.user ?? "" });
      else { prev.x = Math.min(prev.x, g.x); prev.y = Math.min(prev.y, g.y);
             prev.r = Math.max(prev.r, g.x + g.w); prev.b = Math.max(prev.b, g.y + g.h); }
    }
    for (const [jid, gp] of groups) {
      const veh = byId.get(jid);
      const x = gp.x + 1, y = gp.y + 1, w = gp.r - gp.x - 2, h = gp.b - gp.y - 2;
      ctx.fillStyle = withAlpha(this.ownerColor(gp.user, scene), 0.85);
      const path = new Path2D();
      roundRectPath(path, x, y, w, h, 3);
      ctx.fill(path);
      // Remaining-time tick: distance from the right edge = remaining walltime.
      const end = veh?.end ?? null;
      const est = veh?.est ?? 0;
      if (end !== null && est > 0) {
        const rem = clamp((end - scene.now) / est, 0, 1);
        ctx.strokeStyle = withAlpha(this.c("ink"), 0.8);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + w * (1 - rem), y + 2);
        ctx.lineTo(x + w * (1 - rem), y + h - 2);
        ctx.stroke();
      }
    }
  }

  /** Reservation cones (Art 5): one per `scene.cones` entry — bay-backed ones (viewer hand cones)
   *  sit on the lot's road-side edge over their bays; engine reservations (the snapshot carries no
   *  reserved bays) sit on the vehicle itself, never on guessed bays. Countdown = a shrinking tick
   *  plus a text label, both keyed on sim time only. */
  private drawCones(ctx: CanvasRenderingContext2D, scene: CampusScene): void {
    const geom = bayGeom(scene);
    const slots = roadSlots(scene);
    const byId = new Map(scene.vehicles.map((v) => [v.id, v]));
    ctx.font = FONT_LABEL;
    ctx.textAlign = "center";
    for (const cone of scene.cones) {
      const veh = byId.get(cone.job);
      let cx: number | null = null;
      let edgeY: number | null = null;
      if (cone.bays.length) {
        let sum = 0, n = 0, bottom = 0;
        for (const bid of cone.bays) {
          const g = geom.get(bid);
          if (!g || !g.lot) continue;
          sum += g.x + g.w / 2; n += 1;
          bottom = Math.max(bottom, g.lot.y + g.lot.h);
        }
        if (n) { cx = sum / n; edgeY = bottom; }
      }
      if (cx === null || edgeY === null) {
        // no bays (engine intent) — the cone hovers over the vehicle on the road
        if (!veh) continue;
        const s = slots.get(cone.job);
        if (!s) continue;
        cx = s.x + s.w / 2; edgeY = s.y + s.len + 2;
      }
      const path = new Path2D();
      ctx.fillStyle = withAlpha(this.c("veh-reserved"), 0.25);
      path.moveTo(cx - CONE_W / 2, edgeY);
      path.lineTo(cx + CONE_W / 2, edgeY);
      path.lineTo(cx, edgeY + CONE_H);
      path.closePath();
      ctx.fill(path);
      ctx.strokeStyle = this.c("veh-reserved");
      ctx.lineWidth = 1;
      ctx.stroke(path);
      if (cone.until !== null) {
        const rem = Math.max(0, cone.until - scene.now);
        const frac = clamp(rem / RESERVE_SPAN, 0, 1);
        ctx.strokeStyle = this.c("veh-reserved");
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - CONE_W / 2, edgeY + CONE_H + 3);
        ctx.lineTo(cx - CONE_W / 2 + CONE_W * frac, edgeY + CONE_H + 3);
        ctx.stroke();
        ctx.fillStyle = this.c("veh-reserved");
        ctx.fillText(fmtDur(rem), cx, edgeY + CONE_H + 14);
      }
    }
    ctx.textAlign = "start";
  }

  /** Shape + label + patience ring (ring-track + judgement fill) + numeric-free % mark. */
  private drawNeighbourhoods(ctx: CanvasRenderingContext2D, scene: CampusScene,
                             base: CampusScene | null, p: number): void {
    const prevBy = base ? new Map(base.neighbourhoods.map((n) => [n.user, n])) : null;
    for (const nb of scene.neighbourhoods) {
      const ring = clamp(prevBy ? lerp(prevBy.get(nb.user)?.ring ?? nb.ring, nb.ring, p) : nb.ring, 0, 1);
      const color = this.c(`nb-${(nb.index % 8) + 1}`);
      const r = Math.max(6, nb.r);
      // shape (cached Path2D at unit radius, translated)
      const key = `${((nb.index % 8) + 8) % 8}:${r.toFixed(1)}`;
      let sp = this.shapes.get(key);
      if (!sp) this.shapes.set(key, (sp = shapePathFor(nb.index, r)));
      ctx.save();
      ctx.translate(nb.x, nb.y);
      ctx.fillStyle = withAlpha(color, 0.16);
      ctx.fill(sp);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke(sp);
      ctx.restore();
      // label
      ctx.fillStyle = this.c("ink");
      ctx.font = FONT_LABEL;
      ctx.textAlign = "center";
      ctx.fillText(String(nb.label ?? nb.user ?? "").toUpperCase(), nb.x, nb.y + r + 16);
      // patience ring: track + judgement arc, 12 o'clock start, clockwise
      const rr = r + NB_PAD;
      ctx.strokeStyle = this.c("ring-track");
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(nb.x, nb.y, rr, 0, Math.PI * 2);
      ctx.stroke();
      if (ring > 0.001) {
        ctx.strokeStyle = nb.overflow || ring >= 1 ? this.c("overflow")
          : ring > 0.6 ? this.c("warn") : this.c("ok");
        ctx.beginPath();
        ctx.arc(nb.x, nb.y, rr, -Math.PI / 2, -Math.PI / 2 + ring * Math.PI * 2);
        ctx.stroke();
        // numeric-free % mark: a percent glyph whose lower dot fills by the ring value
        if (ring > 0.05) this.drawPercentMark(ctx, nb.x + rr + 9, nb.y - rr + 4, ring);
      }
      if (nb.overflow) {
        ctx.strokeStyle = this.c("overflow");
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(nb.x, nb.y, rr + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /** "%" without numbers: slash + two dots, the lower dot's wedge encodes the fraction. */
  private drawPercentMark(ctx: CanvasRenderingContext2D, x: number, y: number, frac: number): void {
    ctx.strokeStyle = this.c("ink-soft");
    ctx.fillStyle = this.c("ink-soft");
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + 3.2, y - 4.2);
    ctx.lineTo(x - 3.2, y + 4.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x - 3.4, y - 3.4, 1.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 3.4, y + 3.4);
    ctx.arc(x + 3.4, y + 3.4, 2.6, -Math.PI / 2, -Math.PI / 2 + clamp(frac, 0, 1) * Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  }

  /** Small original dispatch booth at the road's lot-side end: base, roof, lit window, flag.
   *  A booth the tutorial has not revealed yet (`revealed === false`) is drawn dimmed; `undefined`
   *  (live mode / baselines) draws exactly as before. */
  private drawBooth(ctx: CanvasRenderingContext2D, scene: CampusScene): void {
    const b = scene.booth;
    if (!b) return;
    if (b.revealed === false) ctx.save();
    if (b.revealed === false) ctx.globalAlpha = 0.35;
    ctx.fillStyle = this.c("panel");
    ctx.strokeStyle = withAlpha(this.c("ink-soft"), 0.6);
    ctx.lineWidth = 1.5;
    const body = new Path2D();
    roundRectPath(body, b.x, b.y + b.h * 0.35, b.w, b.h * 0.65, 4);
    ctx.fill(body);
    ctx.stroke(body);
    // roof triangle
    ctx.fillStyle = withAlpha(this.c("ink-soft"), 0.8);
    ctx.beginPath();
    ctx.moveTo(b.x - 4, b.y + b.h * 0.38);
    ctx.lineTo(b.x + b.w + 4, b.y + b.h * 0.38);
    ctx.lineTo(b.x + b.w / 2, b.y - 6);
    ctx.closePath();
    ctx.fill();
    // window — booth-light is not a generated token (contract gap): fall back to gold.
    ctx.fillStyle = b.staffed ? this.c("booth-light", "gold") : withAlpha(this.c("line"), 0.9);
    ctx.fillRect(b.x + b.w * 0.18, b.y + b.h * 0.52, b.w * 0.28, b.h * 0.28);
    // semaphore flag: `ok` when the booth is staffed and has picked, `week` otherwise.
    const fx = b.x + b.w * 0.78, fy = b.y + b.h * 0.52;
    ctx.strokeStyle = this.c("ink-soft");
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fx, b.y + b.h * 0.35);
    ctx.lineTo(fx, fy + b.h * 0.2);
    ctx.stroke();
    ctx.fillStyle = b.staffed && scene.chosen ? this.c("ok") : this.c("week");
    ctx.beginPath();
    ctx.moveTo(fx, b.y + b.h * 0.35);
    ctx.lineTo(fx + 12, b.y + b.h * 0.35 + 4);
    ctx.lineTo(fx, b.y + b.h * 0.35 + 8);
    ctx.closePath();
    ctx.fill();
    if (b.revealed === false) ctx.restore();
  }

  /** Overflow pulse: first appearance of `scene.overflow` paints an expanding ring on that
   *  neighbour for PULSE_MS, timed by the caller's progress (no clock here). Under reducedMotion
   *  it is the static full ring (the steady ring above already covers persistence). */
  private drawOverflowPulse(ctx: CanvasRenderingContext2D, scene: CampusScene,
                            base: CampusScene | null, p: number): void {
    const user = scene.overflowUser;
    if (!user) return;
    if (base && base.overflowUser === user) return;           // pulse already painted in earlier frames
    const nb = scene.neighbourhoods.find((n) => n.user === user);
    if (!nb) return;
    const rr = Math.max(6, nb.r) + NB_PAD;
    if (this.reduced) {
      ctx.strokeStyle = withAlpha(this.c("overflow"), 0.6);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(nb.x, nb.y, rr + 10, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    const k = 1 - p;                                          // 1 at first appearance, 0 at 700 ms
    ctx.strokeStyle = withAlpha(this.c("overflow"), 0.8 * k);
    ctx.lineWidth = 1 + 5 * k;
    ctx.beginPath();
    ctx.arc(nb.x, nb.y, rr + 4 + 18 * k, 0, Math.PI * 2);
    ctx.stroke();
  }
}

export const OVERFLOW_PULSE_MS = PULSE_MS;   // documented budget for the caller's progress math
