/**
 * CampusPlay — the live campus controller (phase two, Art 3).
 *
 * It owns the clock: a `requestAnimationFrame` loop advances the SAME engine the CLI runs via
 * `bridge.stepUntil` at `watch_plan.step`-quantized sim time, rebuilds the scene from each
 * snapshot (`campus.ts`, pure), and interpolates between the last two snapshots inside the frame
 * (`campus-render.ts`, pure painting). rAF runs ONLY while something moves (pause/finish stop it),
 * and under `prefers-reduced-motion` there is no interpolation — each snapshot lands instantly.
 * Nothing here decides: placement truth, order, rings, and the calendar all come from the engine.
 */

import { bridge, type Level, type RunResult, type StepState } from "./bridge";
import { buildScene, type CampusScene, type SnapshotLike } from "./campus";
import { hitTest } from "./campus-hit";
import { readTokens } from "./tokens";

export interface CampusPlayOptions {
  level: Level;
  container: HTMLElement;
  reducedMotion?: boolean;
  policy?: string;
  kata?: string;
  /** Deterministic single-frame render for the visual harness: caller drives `renderAt`. */
  manual?: boolean;
  onFinish?: (run: RunResult) => void;
  onStatus?: (text: string) => void;
}

interface SnapshotPair {
  prev: CampusScene | null;
  cur: CampusScene;
  /** wall-capture time of `cur` for interpolation progress */
  at: number;
  simAt: number;
}

export class CampusPlay {
  private readonly opts: CampusPlayOptions;
  private handle = 0;
  private plan = { step: 1, tick: null as number | null, stride: 1, duration: 0 };
  private nodes: { id: string; partition: string; site?: string }[] = [];
  private jobs = new Map<string, SnapshotLike["jobs"] extends (infer T)[] | undefined ? T : never>();
  private raf = 0;
  private lastFrame = 0;
  private speed = 1; // sim seconds per wall second at 1x = plan.step * 4 (tuned once, here)
  private paused = false;
  private finished = false;
  private pair: SnapshotPair | null = null;
  private destroyed = false;
  private manual = false;
  private startPerf = 0;
  private startSim = 0;
  private frameTimes: number[] = [];
  private canvas: HTMLCanvasElement;
  private render: ((scene: CampusScene, prev: CampusScene | null, t: number) => void) | null = null;
  private rendererResize: ((w: number, h: number) => void) | null = null;
  private controls: HTMLElement;
  private clockEl: HTMLElement;
  private detailEl: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;

  private constructor(opts: CampusPlayOptions) {
    this.opts = opts;
    this.manual = opts.manual ?? false;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "campus-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Live campus: neighbourhoods, road of queued jobs, lots");
    this.controls = document.createElement("div");
    this.controls.className = "campus-controls";
    this.clockEl = document.createElement("span");
    this.clockEl.className = "campus-clock hash";
    this.clockEl.setAttribute("role", "status");
    this.detailEl = document.createElement("div");
    this.detailEl.className = "campus-detail";
    this.detailEl.setAttribute("role", "status");
    this.detailEl.hidden = true;
    this.opts.container.append(this.canvas, this.detailEl, this.controls, this.clockEl);
    this.canvas.addEventListener("pointermove", (ev) => this.onPointer(ev));
    this.canvas.addEventListener("pointerleave", () => { this.detailEl.hidden = true; });
  }

  static async create(opts: CampusPlayOptions): Promise<CampusPlay> {
    const c = new CampusPlay(opts);
    (window as unknown as { __campus?: CampusPlay }).__campus = c; // debug hook (dev-visible, harmless)
    await c.start();
    return c;
  }

  private async start(): Promise<void> {
    this.plan = await bridge.watchPlan(this.opts.level);
    const started = await bridge.startRun(this.opts.level,
      { policy: this.opts.policy ?? String(this.opts.level.default_policy ?? "fifo"),
        kata: this.opts.kata ?? null });
    this.handle = started.handle;
    this.nodes = (started.nodes ?? []).map((n) => ({ id: n.id, partition: n.partition,
                                                     site: n.site }));
    this.setupControls();
    this.setupResize();
    await this.setupRenderer();
    this.step_once(started.state);
    this.rebase();
    if (!this.finished && !this.manual) this.request();
  }

  /** Renderer wiring is isolated so a missing/partial module degrades to a textual clock. */
  private async setupRenderer(): Promise<void> {
    try {
      const mod = await import("./campus-render");
      const renderer = new mod.CampusRenderer(this.canvas, {
        reducedMotion: this.opts.reducedMotion ?? false,
      });
      readTokens(); // ensures token CSS is applied before first paint
      this.render = (scene, prev, t) => renderer.render(scene, prev, t);
      this.rendererResize = (w, h) => renderer.resize(w, h);
      this.resizeNow();
    } catch {
      this.render = null; // clock-only fallback (keeps CI/headless alive before Art 3 lands)
    }
  }

  private setupResize(): void {
    const doResize = () => this.resizeNow();
    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(doResize);
      this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    }
    window.addEventListener("resize", doResize);
  }

  private resizeNow(): void {
    const box = this.canvas.parentElement?.getBoundingClientRect();
    const w = Math.max(320, Math.floor(box?.width ?? this.canvas.clientWidth ?? 960));
    const h = Math.floor(Math.min(560, Math.max(380, w * 0.46)));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.rendererResize?.(w, h);
    this.paintFrame(0);
  }

  private setupControls(): void {
    const pauseBtn = document.createElement("button");
    pauseBtn.type = "button";
    pauseBtn.textContent = "Pause";
    pauseBtn.setAttribute("aria-pressed", "false");
    pauseBtn.addEventListener("click", () => {
      this.paused = !this.paused;
      pauseBtn.textContent = this.paused ? "Resume" : "Pause";
      pauseBtn.setAttribute("aria-pressed", String(this.paused));
      this.opts.onStatus?.(this.paused ? "campus paused" : "campus running");
      if (!this.paused && !this.finished) {
        this.rebase();
        this.request();
      }
    });
    const speed = document.createElement("select");
    speed.setAttribute("aria-label", "Campus playback speed");
    for (const x of [0.5, 1, 2, 4, 8]) {
      const o = document.createElement("option");
      o.textContent = `${x}x`;
      o.value = String(x);
      if (x === 1) o.selected = true;
      speed.append(o);
    }
    speed.addEventListener("change", () => {
      this.speed = Number(speed.value);
      this.rebase();  // continue from `now` — a slowdown must not rewind the wall target
    });
    this.controls.append(pauseBtn, speed);
  }

  /* ------------------------------------------------------------------ loop -- */

  private rebase(): void {
    this.startPerf = performance.now();
    this.startSim = this.pair?.simAt ?? 0;
  }

  private request(): void {
    if (!this.raf && !this.destroyed) {
      this.raf = requestAnimationFrame(() => void this.frame());
    }
  }

  private async frame(): Promise<void> {
    this.raf = 0;
    if (this.destroyed || this.paused || this.finished) return;
    const ms = performance.now();
    if (this.paused) return;
    const dt = Math.min(0.25, Math.max(0.001, (ms - this.lastFrame) / 1000));
    this.lastFrame = ms;
    // Always advance at least one plan.step per frame (that is the 1x pacing: step × ~60 steps/s);
    // speed multiplies the stride. Never round below a step — a 0-strand re-steps the same instant.
    const simAdvance = Math.max(this.plan.step, Math.round(this.plan.step * this.speed * dt * 60));
    let res;
    try {
      res = await bridge.stepUntil(this.handle, Math.floor(this.simTarget(simAdvance)));
    } catch {
      return; // run ended between frames
    }
    this.step_once(res.state);
    if (!this.finished) this.request();
  }

  /**
   * Wall-clock-anchored pacing: `startPerf` marks the frame-zero, and the sim must reach
   * `startSim + rate * speed * wall_elapsed` by now (rate = plan.step x 60 = the 1x cadence).
   * A fast machine simply gets idle frames; a slow one catches up in one bounded step.
   */
  private simTarget(_delta: number): number {
    const now = this.pair?.simAt ?? 0;
    const wall = (performance.now() - this.startPerf) / 1000;
    const target = this.startSim + wall * this.plan.step * 60 * this.speed;
    const t = Math.max(now + 1, Math.max(target, now + this.plan.step));
    const cap = this.plan.duration ? this.plan.duration + 2 * this.plan.step : Infinity;
    return Math.floor(Math.min(t, cap));  // integer clock — never hand the engine a float
  }

  /** Absorb one snapshot into the scene pair + job union view. */
  private step_once(state: StepState): void {
    const s = state as StepState & { jobs?: SnapshotLike["jobs"] };
    for (const r of state.running) {
      const j = this.jobs.get(r.id);
      if (j) {
        j.start = r.start;
        if (r.end !== undefined) j.end = r.end;
      }
    }
    if (s.jobs) for (const j of s.jobs) this.jobs.set(j.id, { ...this.jobs.get(j.id), ...j });
    // The snapshot lists jobs the viewer has not seen (future arrivals) — they are vehicles too.
    for (const u of (s as { unseen?: SnapshotLike["jobs"] }).unseen ?? []) {
      if (!this.jobs.has(u.id)) this.jobs.set(u.id, { ...u, start: null, end: null, placed: [] } as never);
    }
    // Anything the engine began that the viewer never saw (first snapshot, fast catch-up):
    // synthesize a shell so the vehicle exists; the merge above decorates it.
    for (const r of state.running) {
      if (!this.jobs.has(r.id)) {
        this.jobs.set(r.id, { id: r.id, user: "?", nodes: r.nodes.length, est: 0, submit: state.now,
                              start: r.start, end: r.end ?? null, state: "unfinished",
                              placed: r.nodes } as never);
      }
    }
    const snap: SnapshotLike = {
      now: state.now,
      queued: state.queued,
      running: state.running,
      reserved: state.reserved,
      pressure: state.pressure,
      overflow: state.overflow,
      done: state.done,
      jobs: [...this.jobs.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
      nodes: this.nodes,
    };
    const scene = buildScene({
      width: this.cssWidth(), height: this.cssHeight(),
      nodes: this.nodes, jobs: snap.jobs, snap,
      clock: { week: 1, day: Math.floor(state.now / Math.max(1, this.plan.stride)) + 1,
               sun: ((state.now % (this.plan.stride * 7)) / (this.plan.stride * 7)) || 0 },
    });
    this.pair = { prev: this.pair?.cur ?? null, cur: scene, at: performance.now(), simAt: state.now };
    this.paintFrame(this.opts.reducedMotion || this.manual ? 1 : 0);
    {
      const v = scene.vehicles;
      const running = v.filter((x) => x.state === "running").length;
      const done = v.filter((x) => x.state === "done").length;
      this.clockEl.textContent =
        `day ${scene.day} · t=${fmt(state.now)} · ${running} on campus · ${done}/${v.length} done`;
    }
    if (state.done) void this.finish();
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    try {
      const res = await bridge.stepResult(this.handle);
      // step_result now carries the engine's score/bars/seed/policy and the real-placement jobs.
      const run = {
        ...(res as unknown as RunResult),
        level_id: String(this.opts.level.id ?? ""),
        nodes: this.nodes,
        n_jobs: (this.jobs?.size ?? 0) || ((res as unknown as RunResult).jobs?.length ?? 0),
      } as RunResult;
      this.opts.onFinish?.(run);
      this.opts.onStatus?.("campus run finished");
    } catch {
      this.opts.onStatus?.("campus run ended");
    }
  }

  /* ---------------------------------------------------------------- paint -- */

  private onPointer(ev: PointerEvent): void {
    if (!this.pair) return;
    const box = this.canvas.getBoundingClientRect();
    const hit = hitTest(this.pair.cur, { x: ev.clientX - box.left, y: ev.clientY - box.top });
    if (!hit) {
      this.detailEl.hidden = true;
      return;
    }
    this.detailEl.hidden = false;
    this.detailEl.textContent = `${hit.label} — ${hit.detail}`;
    this.detailEl.style.left = `${Math.min(box.width - 180, hit.x + 12)}px`;
    this.detailEl.style.top = `${Math.max(8, hit.y - 28)}px`;
  }

  private cssWidth(): number {
    return this.canvas.clientWidth || 960;
  }

  private cssHeight(): number {
    return this.canvas.clientHeight || 440;
  }

  private paintFrame(forceT: number): void {
    if (!this.render || !this.pair) return;
    this.frameTimes.push(performance.now());
    if (this.frameTimes.length > 121) this.frameTimes.shift();
    const elapsed = performance.now() - this.pair.at;
    const t = forceT >= 1 ? 1 : Math.min(1, elapsed / 280);
    this.render(this.pair.cur, this.pair.prev, t);
    if (!this.opts.reducedMotion && !this.manual && t < 1 && !this.paused && !this.finished) {
      this.request();
    }
  }

  /** Frames/s over the sample window (~2 s at 60 Hz) — the Art 3 acceptance metric. */
  fps(): number {
    const ft = this.frameTimes;
    if (ft.length < 4) return 0;
    const span = (ft[ft.length - 1] ?? 0) - (ft[0] ?? 0);
    return span > 0 ? ((ft.length - 1) * 1000) / span : 0;
  }

  /** Advance deterministically to sim time `t` and render one settled frame (harness mode). */
  async seekRender(t: number): Promise<void> {
    const res = await bridge.stepUntil(this.handle, t);
    this.step_once(res.state);
    this.paintFrame(1);
    if (res.state.done) await this.finish();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.opts.container.textContent = "";
  }
}

function fmt(t: number): string {
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m`;
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}
