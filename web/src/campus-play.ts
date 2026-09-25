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

import { bridge, BridgeError, type HandSuggestions, type Level, type RunResult, type StepState } from "./bridge";
import { buildScene, type CampusScene, type SnapshotLike } from "./campus";
import { bayBox, hitTest, vehicleBox } from "./campus-hit";
import { boothCards, openBoothDialog, saveBoothChoice, type BoothDialogHandle } from "./booth";
import { readTokens } from "./tokens";

export interface CampusPlayOptions {
  level: Level;
  container: HTMLElement;
  reducedMotion?: boolean;
  policy?: string;
  kata?: string;
  /** Deterministic single-frame render for the visual harness: caller drives `renderAt`. */
  manual?: boolean;
  /** Art 4: "hand" runs the same engine under the manual policy — the player parks vehicles and
   *  presses Time (`hand_tick`); "live" (default) is the Art 3 auto-stepping campus, untouched. */
  mode?: "live" | "hand";
  /** Kata text whose modules seed the booth's card slots (hand mode's booth dialog). */
  ruleCardsSource?: string;
  /** Art 5: "Open the full editor" — the booth hands its serialization to the kata editor. */
  onOpenEditor?: (kata: string) => void;
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
  /* --- hand mode (Art 4); every field is inert in live mode ---------------------------------- */
  /** Called with every engine snapshot absorbed by `step_once` (the tutorial runner's eyes). */
  onStep?: (state: StepState) => void;
  /** Player-side tutorial events (e.g. "booth_staffed" from the booth dialog). */
  onEvent?: (name: string) => void;
  private readonly handMode: boolean;
  private suggestions: HandSuggestions = {};
  private selected: string | null = null;
  private staged: string[] = [];
  private boothStaffed = true;
  private boothRevealed = true;
  private lockKind: "none" | "hand" | "place" | "booth" = "none";
  private snap: SnapshotLike | null = null;
  private handBusy = false;
  private handBar: HTMLElement | null = null;
  private parkBtn: HTMLButtonElement | null = null;
  private timeBtn: HTMLButtonElement | null = null;
  private toastEl: HTMLElement;
  private toastTimer = 0;
  private chipEl: HTMLElement;
  private boothDialog: BoothDialogHandle | null = null;
  private undoBtn: HTMLButtonElement | null = null;
  private staffedKata: string | null = null;

  private constructor(opts: CampusPlayOptions) {
    this.opts = opts;
    this.manual = (opts.manual ?? false) || opts.mode === "hand"; // hand time advances on presses, never rAF
    this.handMode = opts.mode === "hand";
    if (this.handMode) this.boothStaffed = false; // an unstinted booth has chosen nothing
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
    this.toastEl = document.createElement("div");
    this.toastEl.className = "campus-toast";
    this.toastEl.setAttribute("role", "status");
    this.toastEl.setAttribute("aria-live", "polite");
    this.toastEl.hidden = true;
    this.chipEl = document.createElement("span");
    this.chipEl.className = "campus-mode-chip";
    this.chipEl.setAttribute("role", "status");
    this.chipEl.hidden = true;
    this.opts.container.append(this.canvas, this.detailEl, this.toastEl, this.chipEl, this.controls, this.clockEl);
    this.canvas.addEventListener("pointermove", (ev) => this.onPointer(ev));
    this.canvas.addEventListener("pointerleave", () => { this.detailEl.hidden = true; });
    this.canvas.addEventListener("click", (ev) => this.onCanvasClick(ev)); // no-op outside hand mode
  }

  static async create(opts: CampusPlayOptions): Promise<CampusPlay> {
    const c = new CampusPlay(opts);
    (window as unknown as { __campus?: CampusPlay }).__campus = c; // debug hook (dev-visible, harmless)
    await c.start();
    return c;
  }

  private async start(): Promise<void> {
    this.plan = await bridge.watchPlan(this.opts.level);
    if (this.handMode) {
      // Nothing auto-places: the engine validates every hand_place and the scene is built from
      // the same step snapshots the live campus uses (`hand_tick` returns a full `_snapshot`).
      const started = await bridge.handStart(this.opts.level, null);
      this.handle = started.handle;
      this.nodes = (started.nodes ?? []).map((n) => ({ id: n.id, partition: n.partition,
                                                       site: n.site }));
      this.suggestions = started.suggestions ?? {};
      // `hand_start` already processed the FIRST arrival batch, so those jobs are not in any
      // `unseen` list a viewer could learn from. Seed the job union from a decide-nothing idle
      // start of the same level (arrivals are engine data, not a decision) and discard its
      // handle; the hand run itself is untouched.
      try {
        const seed = await bridge.startRun(this.opts.level, { policy: "idle" });
        this.collect(seed.state);
        await bridge.stepResult(seed.handle);
      } catch { /* the queued-shell fallback in collect() still draws what is queued */ }
      this.setupControls();
      this.setupHandBar();
      this.setupResize();
      await this.setupRenderer();
      this.step_once(started.state);
      return;
    }
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
    } catch (e) {
      console.warn("renderer setup failed", e);
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
    if (this.handMode && this.snap) this.repaint(); // static hand frames must re-project on resize
  }

  private setupControls(): void {
    if (this.handMode) return; // hand runs get the Park/Undo/Time bar instead (setupHandBar)
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

  /** Absorb one snapshot into the job union view and build the SnapshotLike the scene projects. */
  private collect(state: StepState): SnapshotLike {
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
    // Queued but never introduced (hand_start's first batch): a shell at least draws the
    // vehicle; `suggestions` (what FIFO would use) carries its width when the hint has it.
    for (const id of state.queued) {
      if (!this.jobs.has(id)) {
        this.jobs.set(id, { id, user: "?", nodes: this.suggestions[id]?.length ?? 1, est: 0,
                            submit: state.now, start: null, end: null, state: "unfinished",
                            placed: [] } as never);
      }
    }
    return {
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
  }

  /** Absorb one snapshot into the scene pair + job union view. */
  private step_once(state: StepState): void {
    const snap = this.collect(state);
    this.snap = snap;
    const scene = this.sceneFrom(snap);
    this.pair = { prev: this.pair?.cur ?? null, cur: scene, at: performance.now(), simAt: state.now };
    this.paintFrame(this.opts.reducedMotion || this.manual ? 1 : 0);
    {
      const v = scene.vehicles;
      const running = v.filter((x) => x.state === "running").length;
      const done = v.filter((x) => x.state === "done").length;
      this.clockEl.textContent =
        `day ${scene.day} · t=${fmt(state.now)} · ${running} on campus · ${done}/${v.length} done`;
    }
    if (this.handMode) this.paintHandControls();
    // The tutorial runner's eyes: one call per engine snapshot, after the scene exists.
    try { this.onStep?.(state); } catch { /* a broken observer must never kill the campus */ }
    if (state.done) void this.finish();
  }

  /** Pure projection of the last snapshot + the current hand-selection into a scene. */
  private sceneFrom(snap: SnapshotLike): CampusScene {
    const sel = this.selected
      ? snap.jobs?.find((j) => j.id === this.selected) ?? null
      : null;
    return buildScene({
      width: this.cssWidth(), height: this.cssHeight(),
      nodes: this.nodes, jobs: snap.jobs, snap,
      clock: { week: 1, day: Math.floor(snap.now / Math.max(1, this.plan.stride)) + 1,
               sun: ((snap.now % (this.plan.stride * 7)) / (this.plan.stride * 7)) || 0 },
      staffed: this.boothStaffed,
      selected: this.selected,
      staged: sel && this.staged.length
        ? { bays: [...this.staged], fits: this.stagedFits(sel, this.staged), user: sel.user }
        : null,
      boothRevealed: this.boothRevealed,
    });
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    try {
      // Hand runs score through `hand_result` (identical payload, same determinism); live runs
      // through `step_result`. Both carry the engine's score/bars/seed and the real placements.
      const res = this.handMode
        ? await bridge.handResult(this.handle)
        : await bridge.stepResult(this.handle);
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

  /* ------------------------------------------------- hand mode (Art 4) ------ */

  /** The compact Park/Undo/Time bar; live mode never builds it. */
  private setupHandBar(): void {
    const bar = document.createElement("div");
    bar.className = "campus-hand-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Hand placement controls");
    const park = document.createElement("button");
    park.type = "button";
    park.textContent = "Park it";
    park.addEventListener("click", () => void this.placeSelected());
    const undo = document.createElement("button");
    undo.type = "button";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => this.undoStaged());
    const time = document.createElement("button");
    time.type = "button";
    time.textContent = "Time ▶";
    time.title = "advance to the next arrival/finish (hand_tick)";
    time.addEventListener("click", () => void this.tick());
    bar.append(park, undo, time);
    this.controls.append(bar);
    this.handBar = bar;
    this.parkBtn = park;
    this.undoBtn = undo;
    this.timeBtn = time;
  }

  /** Advance the manual clock one arrival/finish batch — the hand campus has no rAF clock. */
  private async tick(): Promise<void> {
    if (this.handBusy || this.finished) return;
    this.handBusy = true;
    try {
      const res = await bridge.handTick(this.handle);
      this.suggestions = res.suggestions ?? this.suggestions;
      this.step_once(res.state);
      if (res.done) this.showToast("Nothing left to park — the run is over.", false);
    } catch (error) {
      this.showToast(this.errorText(error), true);
    } finally {
      this.handBusy = false;
      this.paintHandControls();
    }
  }

  /** `hand_place`: the engine validates everything; a PolicyError is a toast, never a crash. */
  private async placeSelected(): Promise<void> {
    if (this.handBusy || this.finished || !this.selected || !this.staged.length) return;
    if (this.lockKind === "hand" || this.lockKind === "place") return;
    const job = this.selected;
    const nodes = [...this.staged];
    this.handBusy = true;
    try {
      const res = await bridge.handPlace(this.handle, job, nodes);
      this.step_once(res.state); // the parked vehicle shows as running in the same snapshot
      if (res.ok) {
        this.selected = null;
        this.staged = [];
        this.repaint();
      } else if (res.error) {
        // Keep the selection staged so a fix (one bay more/moves) is one click away.
        this.showToast(`${res.error.code}: ${res.error.message}`, true);
      }
    } catch (error) {
      this.showToast(this.errorText(error), true);
    } finally {
      this.handBusy = false;
      this.paintHandControls();
    }
  }

  private undoStaged(): void {
    if (this.finished) return;
    if (this.staged.length) this.staged.pop();
    else this.selected = null;
    this.repaint();
  }

  /** tap vehicle → select; tap bay → stage; tap booth → rule cards (hand mode only). */
  private onCanvasClick(ev: MouseEvent): void {
    if (!this.handMode || this.finished || !this.pair) return;
    const box = this.canvas.getBoundingClientRect();
    const hit = hitTest(this.pair.cur, { x: ev.clientX - box.left, y: ev.clientY - box.top });
    if (hit?.kind === "vehicle") {
      if (this.lockKind === "hand") return;
      this.selected = this.selected === hit.id ? null : hit.id;
      this.staged = [];
      this.repaint();
    } else if (hit?.kind === "bay") {
      if (!this.selected || this.lockKind === "hand" || this.lockKind === "place") return;
      const at = this.staged.indexOf(hit.id);
      if (at >= 0) this.staged.splice(at, 1);
      else this.staged.push(hit.id); // an occupied bay may be staged — it previews red, the engine decides
      this.repaint();
    } else if (hit?.kind === "booth") {
      if (!this.boothRevealed) this.showToast("The booth is not open yet — keep parking.", false);
      else if (this.lockKind !== "booth") this.openBooth();
    } else if (this.selected) {
      this.selected = null;
      this.staged = [];
      this.repaint();
    }
  }

  private openBooth(opts: { mode?: "cards" | "line"; slot?: string; card?: string } = {}): void {
    this.boothDialog?.close();
    const kataSource = this.staffedKata ?? this.opts.ruleCardsSource ?? "";
    this.boothDialog = openBoothDialog({
      kataSource,
      staffed: this.boothStaffed || boothCards(kataSource).length > 0,
      mode: opts.mode,
      focusSlot: opts.slot,
      focusCard: opts.card,
      onChange: (kata, kind) => this.boothChanged(kata, kind),
      onOpenEditor: (kata) => {
        this.boothDialog?.close();
        this.opts.onOpenEditor?.(kata);
      },
    });
  }

  /**
   * Art 5: a booth change is recorded, not pushed — there is NO mid-run policy switch in the
   * bridge (`hand_start` runs the manual policy; inventing one would be inventing engine
   * behavior). The serialization persists for the next kata run (`boothKata` prefs → the kata
   * editor's `initialKata`) and is announced to the tutorial (`card_swapped` / `line_edited`,
   * plus `booth_staffed` the first time the booth stops being empty). The staffed state mirrors
   * the engine contract: a booth with slotted cards has chosen rules.
   */
  private boothChanged(kata: string, kind: "slot" | "edit"): void {
    const had = this.boothStaffed;
    this.staffedKata = kata;
    const names = boothCards(kata).map((c) => c.name);
    this.boothStaffed = names.length > 0;
    if (this.boothStaffed) saveBoothChoice(names.join(" + "), kata);
    this.onEvent?.(kind === "edit" ? "line_edited" : "card_swapped");
    if (!had && this.boothStaffed) this.onEvent?.("booth_staffed");
    this.repaint();
  }

  /** Would this staged set fit? A client-side GUESS for the ghost only — `hand_place` decides. */
  private stagedFits(job: { id: string; nodes: number }, staged: string[]): boolean {
    if (staged.length !== job.nodes) return false;
    const occupied = new Set((this.snap?.running ?? []).flatMap((r) => r.nodes));
    if (staged.some((id) => occupied.has(id))) return false;
    // `suggestions` (what FIFO would take) only CONFIRMS: a matching set is certainly a fit; a
    // different all-free right-size set may fit too — `hand_place` is the truth either way.
    return true;
  }

  /** Repaint after a pure-UI state change (selection/staging/reveal) — no engine call. */
  private repaint(): void {
    if (!this.snap) return;
    const scene = this.sceneFrom(this.snap);
    this.pair = { prev: null, cur: scene, at: performance.now(), simAt: this.snap.now };
    this.paintFrame(1);
    this.paintHandControls();
  }

  private paintHandControls(): void {
    if (!this.handMode) return;
    const locked = this.lockKind;
    if (this.handBar) this.handBar.hidden = this.finished;
    this.parkBtn?.toggleAttribute("disabled",
      this.finished || !this.selected || !this.staged.length
      || locked === "hand" || locked === "place");
    this.undoBtn?.toggleAttribute("disabled",
      this.finished || (!this.selected && !this.staged.length));
    // Time is the suggested action whenever nothing is selectable — an empty road says "advance".
    const roadEmpty = (this.snap?.queued.length ?? 0) === 0;
    this.timeBtn?.classList.toggle("suggest", !this.finished && roadEmpty);
  }

  private showToast(message: string, error: boolean): void {
    window.clearTimeout(this.toastTimer);
    this.toastEl.textContent = message;
    this.toastEl.classList.toggle("error", error);
    this.toastEl.hidden = false;
    this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true; }, error ? 8000 : 5000);
  }

  private errorText(error: unknown): string {
    return error instanceof BridgeError ? `${error.code}: ${error.message}`
      : error instanceof Error ? error.message : String(error);
  }

  /* ------------------------------------------------ public surface (runner) -- */

  /** The stage element the tutorial anchors its own DOM to. */
  get stage(): HTMLElement { return this.opts.container; }

  /** Seconds per calendar day (engine `watch_plan.stride`) — the runner's day arithmetic. */
  get dayStride(): number { return Math.max(1, this.plan.stride); }

  /** The level horizon in sim seconds (`watch_plan.duration`) — its one-week week-end. */
  get durationSec(): number { return this.plan.duration; }

  get isHand(): boolean { return this.handMode; }

  currentScene(): CampusScene | null { return this.pair?.cur ?? null; }

  /** The booth is drawn dimmed (and refuses taps) until the tutorial reveals it. */
  revealBooth(revealed = true): void {
    this.boothRevealed = revealed;
    this.repaint();
  }

  /** Scripted `lock`: the named control is disabled (`none` disables nothing). */
  setLock(kind: "none" | "hand" | "place" | "booth"): void {
    this.lockKind = kind;
    this.paintHandControls();
  }

  /** A scripted `set_mode` beats as a chip on the canvas (`""` clears it). */
  setModeChip(text: string): void {
    this.chipEl.textContent = text;
    this.chipEl.hidden = !text;
  }

  notifyEvent(name: string): void { this.onEvent?.(name); }

  /** Art 5 (tutorial `swap_card` / `edit_line` / `set_mode booth:*`): open — or re-aim — the
   *  booth panel; `slot` pulses a slot zone, `mode: "line"` focuses the one-line editor. */
  openBoothPanel(opts: { mode?: "cards" | "line"; slot?: string; card?: string } = {}): void {
    if (!this.handMode || this.finished || this.lockKind === "booth") return;
    this.revealBooth(true);
    if (this.boothDialog) this.boothDialog.showMode(opts);
    else this.openBooth(opts);
  }

  /** The kata text the booth currently stands for (the tutorial's `cards_placed` source). */
  boothKata(): string { return this.staffedKata ?? this.opts.ruleCardsSource ?? ""; }

  /** Art 5 tutorial `highlight`: a transient ring on a scene anchor (a visual nudge — it
   *  decides nothing and reads nothing but the current projection, so sim time never gates it). */
  pulseAnchor(name: string): boolean {
    const at = this.anchorPoint(name);
    if (!at) return false;
    const el = document.createElement("div");
    el.className = "campus-pulse";
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    this.opts.container.append(el);
    window.setTimeout(() => el.remove(), 1300);
    return true;
  }

  /** Canvas-space point for a tutorial anchor name (Concepts/Campus scene vocabulary). */
  anchorPoint(name: string, lastPlacedId?: string | null): { x: number; y: number } | null {
    const s = this.pair?.cur;
    if (!s) return null;
    const center = (b: { x: number; y: number; w: number; h: number }) =>
      ({ x: b.x + b.w / 2, y: b.y });
    if (name === "road") return { x: s.road.x + s.road.w / 2, y: s.road.y + 8 };
    if (name === "bays" || name === "lots") {
      const lot = s.lots[0];
      return lot ? { x: lot.x + lot.w / 2, y: lot.y + lot.h / 2 } : null;
    }
    if (name === "booth") return { x: s.booth.x + s.booth.w / 2, y: s.booth.y };
    if (name === "offers") return { x: this.cssWidth() / 2, y: this.cssHeight() * 0.4 };
    if (name === "vehicle:last_placed") {
      if (lastPlacedId) {
        const bay = s.bays.find((b) => b.occupiedBy === lastPlacedId);
        if (bay) return center(bayBox(s, bay));
      }
      const running = s.vehicles.filter((v) => v.state === "running")
        .sort((a, b) => (b.start ?? 0) - (a.start ?? 0) || (a.id < b.id ? -1 : 1))[0];
      const bay = running ? s.bays.find((b) => b.occupiedBy === running.id) : null;
      return bay ? center(bayBox(s, bay)) : { x: s.road.x + s.road.w / 2, y: s.road.y + 8 };
    }
    if (name.startsWith("ring:")) {
      const who = name.slice(5);
      const nb = who === "any_moving"
        ? s.neighbourhoods.find((n) => n.ring > 0.01) ?? s.neighbourhoods[0]
        : s.neighbourhoods.find((n) => n.user === who) ?? s.neighbourhoods[0];
      return nb ? { x: nb.x, y: nb.y - nb.r - 12 } : null;
    }
    if (name.startsWith("bay:")) {
      const bay = s.bays.find((b) => b.id === name.slice(4));
      return bay ? center(bayBox(s, bay)) : null;
    }
    if (name.startsWith("vehicle:")) {
      const v = s.vehicles.find((x) => x.id === name.slice(8));
      return v ? center(vehicleBox(s, v)) : null;
    }
    return null;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    window.clearTimeout(this.toastTimer);
    this.boothDialog?.close();
    this.opts.container.textContent = "";
  }
}

function fmt(t: number): string {
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m`;
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}
