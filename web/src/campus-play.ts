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

import { bridge, BridgeError, type BuildingInfo, type HandSuggestions, type Level, type RunResult,
  type StepState, type TraceRecord, type UpgradeInfo } from "./bridge";
import { buildScene, buildingHint, fairnessShares, type CampusScene, type Cone,
  type SnapshotLike } from "./campus";
import { bayBox, hitTest, vehicleBox } from "./campus-hit";
import { misfitReason, whyRows, WHY_EMPTY, type JobFacts } from "./campus-why";
import { boothCards, openBoothDialog, saveBoothChoice, type BoothDialogHandle } from "./booth";
import { readTokens } from "./tokens";
import { acceptOffer, getProgression } from "./progression";
import { load, save } from "./persistence";
import { openOffersPanel, type OfferCard, type OfferVerdict, type OffersPanelHandle } from "./offers";

/**
 * Art 5b: how many decision records the engine keeps for the why-panel (`start(trace=N)` — a ring
 * buffer, so a long run costs a bounded snapshot extra and a headless run pays nothing).
 */
const TRACE_DEPTH = 24;

export interface CampusPlayOptions {
  level: Level;
  container: HTMLElement;
  /**
   * Art 6b: the campus right rail — the fairness share meters mount here. Optional and NEVER
   * passed by the visual harness, so the canvas's parent geometry (every Art 3 baseline) is
   * untouched; `main.ts` owns the element and clears it between runs.
   */
  rail?: HTMLElement;
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
  /* --- Art 5b: why-panel, step mode, hand cones, misfit feedback, keyboard (live-only fields
   *     stay inert in hand mode and vice versa, so neither view's pixels move) ------------------ */
  private whyPanel: HTMLElement | null = null;
  private whyList: HTMLElement | null = null;
  private whyAny = false;
  /** painted trace rows by engine `seq` — so a step announces only what is NEW */
  private readonly whyEls = new Map<number, HTMLElement>();
  private tokens: Record<string, string> = {};
  private pauseBtn: HTMLButtonElement | null = null;
  private stepBtn: HTMLButtonElement | null = null;
  private stepMode = false;
  private stepBusy = false;
  /** viewer-side hand cones ("Cone it"); decay on sim time, never wall clock, never engine truth */
  private handCones: Cone[] = [];
  private coneBtn: HTMLButtonElement | null = null;
  private reasonEl: HTMLElement | null = null;
  private reasonTimer = 0;
  /** keyboard cursor (Art 5b §7): the vehicle index, then the bay-window offset */
  private kbVehicle = -1;
  private kbBayOffset = 0;
  /* --- Art 6a: week end, offers as buildings, building sprites (inert in the manual harness, so
   *     every Art 3 baseline is byte-identical) --------------------------------------------- */
  /** the visual harness (`manual: true`) drives its own frames: no freeze, no buildings */
  private harnessMode = false;
  /** sim time the CURRENT week ends (engine `calendar_at`, §5.6) — never a wall clock */
  private weekEndAt = Number.POSITIVE_INFINITY;
  private weekNum = 1;
  private weekFrozen = false;
  /** the week that ended (its offers/accept are keyed `city:week` by the engine) */
  private frozenWeek = 1;
  private pendingFinish = false;
  private weekPanel: OffersPanelHandle | null = null;
  private weekPanelPromise: Promise<void> | null = null;
  private offersBtn: HTMLButtonElement | null = null;
  /** building names of the last offers fetch (for the take message) */
  private readonly offerNames = new Map<string, string>();
  /** owned buildings (`progression_view.buildings`); ∩ `revealedBuildings` reaches the scene */
  private buildingDefs: BuildingInfo[] = [];
  /** tutorial-managed: owned-but-unrevealed buildings draw dimmed + `?`; null = all revealed */
  private revealedBuildings: Set<string> | null = null;
  private managedByTutorial = false;
  private readonly paintedBuildings = new Set<string>();
  private scenePaintedOnce = false;
  /* --- Art 6b: the fairness rail (never built for the visual harness) --------------------- */
  private railEl: HTMLElement | null = null;
  private fairnessCard: HTMLElement | null = null;
  private fairnessList: HTMLElement | null = null;
  private readonly fairnessEls = new Map<string, HTMLElement>();
  private readonly fairnessParts = new Map<string, { fill: HTMLElement; tick: HTMLElement;
    text: HTMLElement; mark: HTMLElement }>();
  /** a `reveal {building: fairness}` beat showed the board before the save owned it */
  private fairnessFlashed = false;

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
    // Art 6b: the fairness meters live in the caller's right rail (never in the canvas column, so
    // the canvas geometry — and every Art 3 baseline — is untouched). Structural DOM, not paint:
    // a list of text rows a screen reader can browse ([[Accessibility]] known gap about the canvas).
    if (opts.rail && !this.opts.manual) {
      this.railEl = opts.rail;
      const card = document.createElement("section");
      card.className = "campus-fairness";
      card.setAttribute("aria-labelledby", "campus-fairness-title");
      card.hidden = true;
      const head = document.createElement("h3");
      head.id = "campus-fairness-title";
      head.textContent = "Fairness — who is parked";
      const note = document.createElement("p");
      note.className = "campus-fairness-note";
      note.textContent = "Share of vehicle-minutes served so far vs share of what each "
        + "neighbourhood submitted. A ◆ marks a neighbour served under half its share.";
      const list = document.createElement("ul");
      list.className = "campus-fairness-list";
      list.setAttribute("role", "list");
      list.setAttribute("aria-label", "Per-neighbourhood served share versus submitted share");
      card.append(head, note, list);
      this.railEl.append(card);
      this.railEl.hidden = true;
      this.fairnessCard = card;
      this.fairnessList = list;
    }
    // Art 5b: the why-panel lives in the stage, under the clock. It reads the engine's decision
    // trace only, is collapsible, and announces new rows politely. A hand booth has decided
    // nothing (the manual policy places nothing), so the panel stays hidden there.
    const why = document.createElement("details");
    why.className = "campus-why";
    const whyHead = document.createElement("summary");
    whyHead.textContent = "Why the booth chose";
    const whyBody = document.createElement("div");
    whyBody.className = "campus-why-body";
    const whyList = document.createElement("div");
    whyList.className = "campus-why-list";
    whyList.setAttribute("role", "log");
    whyList.setAttribute("aria-live", "polite");
    whyList.setAttribute("aria-label", "Booth decisions");
    whyBody.append(whyList);
    why.append(whyHead, whyBody);
    this.whyPanel = why;
    this.whyList = whyList;
    this.opts.container.append(this.canvas, this.detailEl, this.toastEl, this.chipEl,
      this.controls, this.clockEl, why);
    if (this.handMode) why.hidden = true;
    this.canvas.addEventListener("pointermove", (ev) => this.onPointer(ev));
    this.canvas.addEventListener("pointerleave", () => { this.detailEl.hidden = true; });
    this.canvas.addEventListener("click", (ev) => this.onCanvasClick(ev)); // no-op outside hand mode
    this.canvas.addEventListener("keydown", (ev) => this.onCanvasKey(ev)); // no-op outside hand mode
  }

  static async create(opts: CampusPlayOptions): Promise<CampusPlay> {
    const c = new CampusPlay(opts);
    (window as unknown as { __campus?: CampusPlay }).__campus = c; // debug hook (dev-visible, harmless)
    await c.start();
    return c;
  }

  private async start(): Promise<void> {
    this.plan = await bridge.watchPlan(this.opts.level);
    // Art 6a: the calendar boundary, the owned buildings, and the pending-offers hatch — all
    // skipped in the deterministic visual harness (`manual: true`), so Art 3 baselines hold.
    this.harnessMode = this.opts.manual ?? false;
    await this.setupArt6();
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
      // Art 5b §7: hand play is reachable with no pointer — the canvas takes focus and the arrow
      // keys walk it (vehicle → its bays), Enter parks, Esc clears.
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute("aria-label",
        "Campus, played by hand. Arrow keys choose a vehicle, then its bays; Enter parks it; "
        + "Escape clears the choice.");
      this.setupResize();
      await this.setupRenderer();
      this.step_once(started.state);
      return;
    }
    const started = await bridge.startRun(this.opts.level,
      { policy: this.opts.policy ?? String(this.opts.level.default_policy ?? "fifo"),
        kata: this.opts.kata ?? null,
        // Art 5b: the why-panel's feed. Off elsewhere (`run`/`hand_start` stay trace-free).
        trace: TRACE_DEPTH });
    this.handle = started.handle;
    this.nodes = (started.nodes ?? []).map((n) => ({ id: n.id, partition: n.partition,
                                                     site: n.site }));
    this.setupControls();
    this.setupResize();
    await this.setupRenderer();
    this.step_once(started.state);
    this.paintWhy([]);
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
      readTokens();            // ensures the token CSS is applied before the first paint…
      this.tokens = readTokens();  // …and keeps the table the why-panel rows are colored from
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
      if (this.weekFrozen && !this.paused) {
        this.showToast("Traffic waits: take one of the week's two offers first.", false);
        void this.openWeekOffers(this.frozenWeek);
        return;
      }
      this.paused = !this.paused;
      if (!this.paused) this.stepMode = false;   // wall-clock pacing is back; stepping is not
      this.syncStepButton();
      this.syncPauseButton();
      this.opts.onStatus?.(this.paused ? "campus paused" : "campus running");
      if (!this.paused && !this.finished) {
        this.rebase();
        this.request();
      }
    });
    this.pauseBtn = pauseBtn;
    // Art 5b: Step mode — the booth decides one EVENT BATCH per press (`step_n(handle, 1)`: one
    // timestamp's arrivals/frees/decisions, which is where every trace record comes from), with the
    // why-panel refreshed from the same result. The rAF clock stands still while you step.
    const stepBtn = document.createElement("button");
    stepBtn.type = "button";
    stepBtn.textContent = "Step ▸";
    stepBtn.title = "advance one event batch (step_n) and read why — the clock stays paused";
    stepBtn.addEventListener("click", () => void this.stepOne());
    this.stepBtn = stepBtn;
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
    this.controls.append(pauseBtn, stepBtn, speed);
  }

  /* ------------------------------------------- Art 6a: week end + buildings -- */

  /**
   * The city this campus is (offers are keyed `city:week`): the digits at the end of the level
   * id (`level4` → 4 — city editions keep the canonical id, §5.6/city patches). 1 otherwise.
   */
  get cityNumber(): number {
    const m = String(this.opts.level.id ?? "").match(/(\d+)\s*$/);
    return m ? Number(m[1]) || 1 : 1;
  }

  /** Engine calendar boundary + owned buildings + the pending-offers hatch (harness: nothing). */
  private async setupArt6(): Promise<void> {
    if (this.harnessMode) return;
    try {
      const cal = await bridge.calendarAt(0, this.opts.level);
      this.weekEndAt = cal.week_end;
      this.weekNum = Math.max(1, cal.week);
    } catch { /* week detection falls back to the snapshot `week` field in weekTick */ }
    await this.refreshBuildings();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Week end — offers";
    btn.title = "traffic is frozen until you take one of the week's two offers";
    btn.addEventListener("click", () => { void this.openWeekOffers(this.frozenWeek); });
    btn.hidden = true;
    this.controls.append(btn);
    this.offersBtn = btn;
  }

  /** Re-read the owned buildings (`progression_view.buildings`) and repaint the sprites in. */
  async refreshBuildings(): Promise<void> {
    if (this.harnessMode) return;
    try {
      const view = await bridge.progressionView(getProgression());
      this.buildingDefs = view.buildings ?? [];
    } catch { /* keep the last known set — a failed read must not empty the campus */ }
    this.repaint();
  }

  /** The scene list: owned buildings, revealed unless a tutorial is managing reveals. */
  private sceneBuildings(): NonNullable<Parameters<typeof buildScene>[0]["buildings"]> {
    return this.buildingDefs.map((b) => ({
      id: b.id, name: b.name, blurb: b.blurb, anchor: b.anchor,
      revealed: this.revealedBuildings ? this.revealedBuildings.has(b.id) : true,
    }));
  }

  /** Snapshots in: has the engine clock reached the week boundary? (sim time only, §Determinism) */
  private weekTick(state: StepState): void {
    if (this.weekFrozen) return;
    const wk = state.week ?? this.weekNum;
    if (wk > this.weekNum || (Number.isFinite(this.weekEndAt) && state.now >= this.weekEndAt)) {
      this.frozenWeek = this.weekNum;          // the week that ENDED is the one that offers
      this.weekFrozen = true;
      if (this.handMode) this.paintHandControls();
      else { this.paused = true; this.syncPauseButton(); }
      this.setOffersButton(true);
      this.opts.onStatus?.(`week ${this.frozenWeek} ended — traffic frozen until you take one of the offers`);
      // The freeze is the engine's week boundary (§5.6) — it IS the `week_end` event. Hand
      // snapshots pin `week: 1` (hand sessions register no level for the snapshot calendar), so
      // a runner watching snapshots alone could miss the boundary its waits gate on. Dedup-safe:
      // TutorialRunner.event() ignores repeats.
      this.onEvent?.("week_end");
      if (!this.managedByTutorial) void this.openWeekOffers(this.frozenWeek);
    }
  }

  /**
   * The choice was made (own overlay or the tutorial's beat): unfreeze, move past the boundary,
   * and ask the engine where the NEXT boundary is. A finished run held by the freeze now lands.
   */
  private resolveWeek(): void {
    if (!this.weekFrozen) return;
    this.weekFrozen = false;
    this.weekNum = this.frozenWeek + 1;        // we are in the next week
    this.weekEndAt = Number.POSITIVE_INFINITY; // until the engine recomputes
    this.setOffersButton(false);
    if (!this.finished) {
      if (this.handMode) this.paintHandControls();
      else if (!this.stepMode) {
        this.paused = false;
        this.syncPauseButton();
        this.rebase();
        this.request();
      }
      if (this.pendingFinish) { this.pendingFinish = false; void this.finish(); }
    }
    void bridge.calendarAt(this.pair?.simAt ?? 0, this.opts.level).then((cal) => {
      this.weekNum = Math.max(this.weekNum, cal.week);
      this.weekEndAt = cal.week_end;
    }).catch(() => undefined);
  }

  /**
   * Open the week's two offers (the ONE offers overlay — `offers.ts` — shared with the tutorial's
   * `pick_of` beat). Resolves when the panel is dismissed. While frozen the panel takes the
   * BOUNDARY week (the week that ended), not the caller's possibly-post-boundary guess; "Later"
   * closes it unresolved and the hatch button stays, so the freeze can never trap the player.
   */
  openWeekOffers(preferredWeek: number, onTaken?: (id: string) => void): Promise<void> {
    if (this.weekPanel?.isOpen() && this.weekPanelPromise) return this.weekPanelPromise;
    const week = this.weekFrozen ? this.frozenWeek : preferredWeek;
    const promise = (async (): Promise<void> => {
      const cards = await this.offerCards(week);
      if (cards === null) {                       // bridge hiccup: keep the hatch, allow a retry
        this.setOffersButton(this.weekFrozen);
        this.weekPanelPromise = null;
        return;
      }
      if (!cards.length && this.weekFrozen) {     // genuinely nothing eligible: do not trap anyone
        this.resolveWeek();
        this.weekPanelPromise = null;
        return;
      }
      await new Promise<void>((resolve) => {
        this.weekPanel = openOffersPanel({
          host: this.opts.container,
          title: `End of week ${week} — take one building`,
          cards,
          later: true,
          onTake: (id) => this.takeOffer(week, id, onTaken),
          onDismiss: () => {
            this.weekPanel = null;
            this.weekPanelPromise = null;
            this.setOffersButton(this.weekFrozen);
            resolve();
          },
        });
        this.setOffersButton(false);
      });
    })();
    this.weekPanelPromise = promise;
    return promise;
  }

  /** The two offered buildings, as inspectable cards (`progression_view` metadata — BUILDINGS). */
  private async offerCards(week: number): Promise<OfferCard[] | null> {
    let ids: string[] | null;
    try {
      ids = (await bridge.offersList(getProgression(), this.cityNumber, week)).offers ?? [];
    } catch (error) {
      console.warn("campus: offers_list failed", error);
      return null;
    }
    let upgrades: Record<string, UpgradeInfo> = {};
    try {
      upgrades = (await bridge.progressionView(getProgression())).upgrades ?? {};
    } catch { /* names fall back to ids; the offer pair itself is already engine truth */ }
    this.offerNames.clear();
    return ids.map((id) => {
      const u = upgrades[id];
      const name = u?.name ?? id;
      this.offerNames.set(id, name);
      const tier = u?.unlocks?.[0] ?? id;
      return { id, name, blurb: u?.blurb ?? "", unlocks: `Unlocks the \`${tier}\` tier of Kata.` };
    });
  }

  /** Take an offer: the FREE `offer_accept` grant (credits never move); the state is persisted. */
  private async takeOffer(week: number, id: string,
                          onTaken?: (id: string) => void): Promise<OfferVerdict> {
    const name = this.offerNames.get(id) ?? id;
    try {
      const res = await acceptOffer(this.cityNumber, week, id);
      if (res.ok) {
        this.onEvent?.(`upgrade_placed:${id}`);
        onTaken?.(id);
        this.resolveWeek();
        await this.refreshBuildings();
        return { ok: true, message: `${name} stands on the campus — a week-end offer is free; credits never moved.` };
      }
      return { ok: false, message: res.reason === "accepted"
        ? "That week already chose its building — this one stays on the board."
        : res.reason === "not_offered"
          ? "The week never offered that one — take one of the two cards, or Later."
          : `Could not place ${name} (${res.reason}).` };
    } catch (error) {
      return { ok: false, message: this.errorText(error) };
    }
  }

  private setOffersButton(on: boolean): void {
    if (this.offersBtn) this.offersBtn.hidden = !on;
  }

  /** After every scene (re)build: land the pops, run the first-use guidance. Never in harness. */
  private postScene(scene: CampusScene): void {
    if (this.harnessMode) return;
    for (const b of scene.buildings) {
      if (this.paintedBuildings.has(b.id)) continue;
      this.paintedBuildings.add(b.id);
      // The pop: a caller-side ring pulse (CSS, so `prefers-reduced-motion` makes it static).
      // The first scene of the session just loads — existing buildings do not pop on boot.
      if (this.scenePaintedOnce && b.revealed) this.pulseAnchor(`building:${b.id}`);
    }
    this.scenePaintedOnce = true;
    this.guideFirstUse(scene);
  }

  /**
   * First-use guidance (deliverable 4): a revealed, owned building whose mechanic has appeared
   * for the first time gets ONE callout, gated by the `buildingSeen:<id>` pref (permanence, not
   * repetition). The mechanic facts are read off the scene — a cone on the map, a timeout vehicle,
   * a ring that moved, a transferring vehicle — never off a timer.
   */
  private guideFirstUse(scene: CampusScene): void {
    let seen: Record<string, unknown>;
    try { seen = load().prefs; } catch { return }
    for (const b of scene.buildings) {
      if (!b.revealed || seen[`buildingSeen:${b.id}`] !== undefined) continue;
      if (!this.mechanicAppeared(b.id, scene)) continue;
      save({ prefs: { [`buildingSeen:${b.id}`]: true } });
      this.showToast(`${b.name}: ${buildingHint(b.id)}`, false);
    }
  }

  /** Has this building's mechanic shown itself yet? (cheap scene scans, engine facts only) */
  private mechanicAppeared(id: string, scene: CampusScene): boolean {
    switch (id) {
      case "reserve": return scene.cones.length > 0;
      case "sensors":
      case "preempt": return scene.vehicles.some((v) => v.state === "timeout");
      case "fairness": return scene.neighbourhoods.some((n) => n.ring > 0.05);
      case "route": return scene.vehicles.some((v) => v.state === "transferring");
      default: return true;
    }
  }


  /* ---------------------------------------- Art 6b: the fairness rail (meters) -- */

  /**
   * Is the community board pinned on? Two honest ways (§2.4): the save OWNS `fairness` and the
   * sprite is revealed (free play ⇒ owned ⇒ revealed), or a script's `reveal {building: fairness}`
   * beat showed it first (city 5 hangs the board before the grant lands).
   */
  private fairnessPinned(scene: CampusScene): boolean {
    if (this.fairnessFlashed) return true;
    if (!this.buildingDefs.some((b) => b.id === "fairness")) return false;
    return scene.buildings.some((b) => b.id === "fairness" && b.revealed);
  }

  /**
   * Paint the per-neighbourhood share bars from the snapshot's job list (`fairnessShares` does the
   * only fairness arithmetic on the client: integer seconds, sorted users). Structural DOM — a
   * list of text rows, not canvas paint — and NOT a live region, so it never spams per snapshot
   * ([[Accessibility]] rule 3/10).
   */
  private paintFairness(scene: CampusScene): void {
    const card = this.fairnessCard;
    const list = this.fairnessList;
    if (!card || !list || !this.snap) return;
    const show = this.fairnessPinned(scene);
    card.hidden = !show;
    if (this.railEl) this.railEl.hidden = !show;
    if (!show) {
      this.fairnessEls.clear();
      this.fairnessParts.clear();
      list.textContent = "";
      return;
    }
    const rows = fairnessShares(this.snap.jobs ?? [], this.snap.now);
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.user);
      let parts = this.fairnessParts.get(r.user);
      if (!parts) {
        const li = document.createElement("li");
        const who = document.createElement("span");
        who.className = "fairness-who";
        const dot = document.createElement("i");           // the OWNER token colour …
        dot.className = "fairness-dot";
        dot.style.background = this.ownerColor(r.user);
        const name = document.createElement("b");          // … never alone: the label rides with it
        name.textContent = r.user;
        const mark = document.createElement("span");       // the `warn` marker (glyph + word)
        mark.className = "fairness-mark";
        mark.hidden = true;
        who.append(dot, name, mark);
        const bar = document.createElement("div");
        bar.className = "fairness-bar";
        bar.setAttribute("aria-hidden", "true");           // the row's text is the accessible truth
        const fill = document.createElement("i");
        fill.className = "fairness-served";
        fill.style.background = this.ownerColor(r.user);
        const tick = document.createElement("i");          // the entitlement line (their share)
        tick.className = "fairness-due";
        bar.append(fill, tick);
        const text = document.createElement("span");
        text.className = "fairness-text";
        li.append(who, bar, text);
        this.fairnessEls.set(r.user, li);
        parts = { fill, tick, text, mark };
        this.fairnessParts.set(r.user, parts);
        list.append(li);
      }
      const pct = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 100);
      parts.fill.style.width = `${pct(r.servedShare)}%`;
      parts.tick.style.left = `${pct(r.askedShare)}%`;
      parts.text.textContent = `${pct(r.servedShare)}% served of ${pct(r.askedShare)}% submitted `
        + `· ${fmt(r.servedSecs)} parked, ${fmt(r.askedSecs)} claimed`
        + `${r.waiting > 0 ? ` · ${r.waiting} waiting` : ""}`;
      parts.mark.hidden = !r.starved;
      parts.mark.textContent = r.starved ? "\u25c6 starved" : "";
      const li = this.fairnessEls.get(r.user);
      li?.classList.toggle("starved", r.starved);
      if (li) li.title = `${r.user}: ${fmt(r.servedSecs)} of ${fmt(r.askedSecs)} vehicle-minutes `
        + `served (${pct(r.servedShare)}% of all served time vs ${pct(r.askedShare)}% of all `
        + `claimed time)${r.starved ? " — STARVED" : ""}`;
    }
    for (const [user, li] of this.fairnessEls) {
      if (seen.has(user)) continue;
      li.remove();
      this.fairnessEls.delete(user);
      this.fairnessParts.delete(user);
    }
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
    this.paintWhy(res.trace);
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
    // Viewer hand cones decay on SIM time, in step order — never a wall-clock timer, so a paused
    // campus holds its cones and a catch-up step drops the ones that have run out.
    if (this.handCones.length) {
      this.handCones = this.handCones.filter((c) => c.until === null || c.until > state.now);
    }
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
    // Art 6a: the week boundary (engine clock), building pops, and the first-use guidance — all
    // before `onStep` so a tutorial beat sees the freeze already in place. The run's final
    // result waits for an unresolved week: traffic must not finish around a choice it never made.
    if (!this.harnessMode) {
      this.weekTick(state);
      this.postScene(scene);
      this.paintFairness(scene);
    }
    // The tutorial runner's eyes: one call per engine snapshot, after the scene exists.
    try { this.onStep?.(state); } catch { /* a broken observer must never kill the campus */ }
    if (state.done) {
      if (this.weekFrozen) this.pendingFinish = true;
      else void this.finish();
    }
  }

  /** Pure projection of the last snapshot + the current hand-selection into a scene. */
  private sceneFrom(snap: SnapshotLike): CampusScene {
    const sel = this.selected
      ? snap.jobs?.find((j) => j.id === this.selected) ?? null
      : null;
    return buildScene({
      width: this.cssWidth(), height: this.cssHeight(),
      nodes: this.nodes, jobs: snap.jobs, snap,
      clock: { week: this.weekNum, day: Math.floor(snap.now / Math.max(1, this.plan.stride)) + 1,
               sun: ((snap.now % (this.plan.stride * 7)) / (this.plan.stride * 7)) || 0 },
      staffed: this.boothStaffed,
      selected: this.selected,
      staged: sel && this.staged.length
        ? { bays: [...this.staged], fits: this.stagedFits(sel, this.staged), user: sel.user }
        : null,
      boothRevealed: this.boothRevealed,
      handCones: this.handCones,
      buildings: this.harnessMode ? [] : this.sceneBuildings(),
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
    this.paintWhy(res.trace);
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
    // Art 5b: "Cone it" — a VIEWER-side booking hint on the bays the FIFO hint would hand this
    // vehicle when they free. The engine is not told (there is no hand-mode reserve in the bridge),
    // so the button says what it is and the cone decays on sim time. Never implies blocking.
    const cone = document.createElement("button");
    cone.type = "button";
    cone.textContent = "Cone it";
    cone.title = "hold the bays FIFO would give this vehicle when they free — a hint on the map, "
      + "not a booking the engine makes";
    cone.addEventListener("click", () => this.coneSelected());
    bar.append(cone);
    const reason = document.createElement("div");
    reason.className = "campus-reason";
    reason.setAttribute("role", "status");
    reason.setAttribute("aria-live", "polite");
    reason.hidden = true;
    this.controls.append(bar, reason);
    this.handBar = bar;
    this.parkBtn = park;
    this.undoBtn = undo;
    this.timeBtn = time;
    this.coneBtn = cone;
    this.reasonEl = reason;
  }

  /** Advance the manual clock one arrival/finish batch — the hand campus has no rAF clock. */
  private async tick(): Promise<void> {
    if (this.handBusy || this.finished) return;
    if (this.weekFrozen) {
      // The week is not over until a building is chosen — Time waits with the traffic.
      this.showToast("Traffic waits: the week is frozen until you take one of the two offers.", false);
      void this.openWeekOffers(this.frozenWeek);
      return;
    }
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
        // Keep the selection staged so a fix (one bay more/moves) is one click away — but say WHY
        // in campus words first (Art 5b): the engine's code decides the sentence, never a guess.
        this.showMisfit(res.error.code, res.error.message);
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
      this.kbVehicle = this.selected ? this.pair.cur.queuedOrder.indexOf(hit.id) : -1;
      this.kbBayOffset = 0;
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
    if (!this.harnessMode) {
      this.postScene(scene);   // a building granted mid-pause still lands
      this.paintFairness(scene);
    }
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
    this.timeBtn?.toggleAttribute("disabled", this.finished || this.weekFrozen);
    this.timeBtn?.classList.toggle("suggest", !this.finished && roadEmpty && !this.weekFrozen);
    this.coneBtn?.toggleAttribute("disabled",
      this.finished || !this.selected || locked === "hand" || locked === "place");
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

  /* ------------------------------------------- Art 5b: why-panel (live mode) -- */

  /**
   * Paint the engine's last-N decision records into the why-panel. Rows are keyed by the engine's
   * monotonic `seq` and only ever ADDED (a record never changes, and rows older than the ring
   * buffer are dropped), so the `role="log"` region announces what is new and not the whole panel
   * every frame. Hand runs have no trace (the manual policy decides nothing) — the panel is hidden.
   */
  private paintWhy(records: TraceRecord[] | undefined): void {
    const list = this.whyList;
    if (!list || this.handMode || this.whyPanel?.hidden) return;
    const rows = whyRows(records ?? [], (id) => this.factsOf(id));
    const keep = new Set<number>();
    for (const row of rows) {
      keep.add(row.seq);
      if (this.whyEls.has(row.seq)) continue;      // already painted — do not re-announce it
      const el = document.createElement("div");
      el.className = "campus-why-row";
      const t = document.createElement("span");
      t.className = "why-t";
      t.textContent = `t=${fmt(row.t)}`;
      const line = document.createElement("span");
      line.textContent = row.text;
      // The OWNER's color rides on a small bar, not on the sentence: the row still reads whose
      // vehicle it was, and every word stays at the `--sd-ink` contrast the theme is validated at
      // (Concepts/Accessibility rule 8 — palette colors are tuned for the canvas, not for 12 px text).
      const swatch = document.createElement("span");
      swatch.className = "why-dot";
      const color = row.user ? this.ownerColor(row.user) : "";
      if (color) swatch.style.background = color;
      el.append(t, swatch, line);
      this.whyEls.set(row.seq, el);
      list.append(el);
      this.whyAny = true;
    }
    for (const [seq, el] of this.whyEls) {
      if (!keep.has(seq)) { el.remove(); this.whyEls.delete(seq); }
    }
    const empty = list.querySelector(".campus-why-empty");
    if (!this.whyAny && !empty) {
      const p = document.createElement("p");
      p.className = "campus-why-empty";
      p.textContent = WHY_EMPTY;
      list.append(p);
    } else if (this.whyAny && empty) empty.remove();
  }

  /** What the viewer knows about a vehicle (engine facts only — the union view it already keeps). */
  private factsOf(id: string): JobFacts | null {
    const j = this.jobs.get(id);
    if (!j) return null;
    return { user: j.user, est: j.est ?? 0, submit: j.submit ?? 0, nodes: j.nodes ?? 1 };
  }

  /** The neighbourhood token color for an owner (same index the canvas paints with). */
  private ownerColor(user: string): string {
    const nb = this.pair?.cur.neighbourhoods.find((n) => n.user === user);
    let index = nb?.index;
    if (index === undefined) {
      let h = 0;
      for (let i = 0; i < user.length; i++) h = (h * 31 + user.charCodeAt(i)) | 0;
      index = Math.abs(h) % 8;
    }
    return this.tokens[`nb-${(index % 8) + 1}`] ?? "";
  }

  /* -------------------------------------------------- Art 5b: step mode (live) -- */

  /** One press = `step_n(handle, 1)` = one EVENT BATCH (every arrival/free/decision at the next
   *  timestamp), not one job: that is the batch the engine's trace records come from, so the
   *  why-panel gains exactly the rows this press decided. The rAF clock stays paused. */
  private async stepOne(): Promise<void> {
    if (this.stepBusy || this.finished) return;
    if (this.weekFrozen) {
      this.showToast("Traffic waits: take one of the week's two offers first.", false);
      void this.openWeekOffers(this.frozenWeek);
      return;
    }
    this.stepBusy = true;
    this.stepMode = true;
    if (!this.paused) { this.paused = true; this.syncPauseButton(); }
    try {
      const res = await bridge.stepN(this.handle, 1);
      this.step_once(res.state);
      this.paintWhy(res.trace);
      this.paintFrame(1);          // settled frame — no rAF is coming to finish the interpolation
      this.opts.onStatus?.(`campus stepped to t=${fmt(res.state.now)}`);
    } catch (error) {
      this.showToast(this.errorText(error), true);
    } finally {
      this.stepBusy = false;
      this.syncStepButton();
    }
  }

  private syncPauseButton(): void {
    const b = this.pauseBtn;
    if (!b) return;
    b.textContent = this.paused ? "Resume" : "Pause";
    b.setAttribute("aria-pressed", String(this.paused));
    this.stepBtn?.classList.toggle("suggest", this.stepMode);   // while stepping, Step is the action
  }

  private syncStepButton(): void {
    this.stepBtn?.toggleAttribute("disabled", this.finished);
  }

  /* ---------------------------------------------------- Art 5b: hand cones ------ */

  /**
   * "Cone it": a viewer-side booking hint for the selected vehicle. The bays are the ones the
   * ENGINE's own FIFO hint (`suggestions`) would hand it — the player's staged bays win when they
   * are the right size — and the countdown runs out when those bays free (or after the vehicle's
   * claimed length, whichever is later). The engine is NOT told: a cone here books nothing, and the
   * toast says so, because inventing a hand-mode `reserve` would be inventing engine behavior.
   */
  private coneSelected(): void {
    if (this.finished || this.handBusy || !this.selected) return;
    const id = this.selected;
    const job = this.snap?.jobs?.find((j) => j.id === id) ?? null;
    const hinted = this.suggestions[id] ?? [];
    const nodes = Math.max(1, job?.nodes ?? hinted.length ?? 1);
    const staged = this.staged.length === nodes ? [...this.staged].sort() : [];
    const bays = staged.length ? staged
      : hinted.length ? [...hinted].sort()
        : this.bayWindow(this.candidateBays(), nodes, 0);
    if (!bays.length) {
      this.showToast("Nothing to cone yet — no bays on this campus.", false);
      return;
    }
    const now = this.snap?.now ?? 0;
    const freeAt = bays.reduce((max, bay) => Math.max(max, this.bayFreeAt(bay)), now);
    const until = Math.max(freeAt, now + Math.max(1, job?.est ?? 0));
    this.handCones = [...this.handCones.filter((c) => c.job !== id),
                       { job: id, bays, until, from: now }];
    this.repaint();
    this.onEvent?.("cone_placed");
    this.showToast(`Cone on ${bays.join(" ")} — a HINT on the map, not a booking: those bays stay `
      + `open to anything that fits, and the cone lifts by itself at t=${fmt(until)}.`, false);
  }

  /** The bays a hand hint could point at: the free ones (id order), else every bay. */
  private candidateBays(): string[] {
    const occupied = new Set((this.snap?.running ?? []).flatMap((r) => r.nodes));
    const all = this.nodes.map((n) => n.id).sort();
    const free = all.filter((id) => !occupied.has(id));
    return free.length ? free : all;
  }

  /** A contiguous sliding window over `cands` (adjacency is what a k-bay vehicle needs). */
  private bayWindow(cands: readonly string[], nodes: number, offset: number): string[] {
    const k = cands.length;
    if (!k || nodes <= 0) return [];
    const start = ((offset % k) + k) % k;
    const out: string[] = [];
    for (let i = 0; i < k && out.length < Math.min(nodes, k); i++) out.push(cands[(start + i) % k]!);
    return out.sort();
  }

  /** The sim time a bay frees (`end` of whoever holds it, engine-supplied), else now. */
  private bayFreeAt(id: string): number {
    const now = this.snap?.now ?? 0;
    for (const r of this.snap?.running ?? []) if (r.nodes.includes(id)) return r.end ?? now;
    return now;
  }

  /* ------------------------------------------- Art 5b: misfit feedback (hand) -- */

  /** The engine refused a staged set: name the reason, shake the bar, ring it red. */
  private showMisfit(code: string, message: string): void {
    const el = this.reasonEl;
    const text = misfitReason(code, message);
    if (el) {
      el.textContent = text;
      el.classList.add("bad");
      el.hidden = false;
      window.clearTimeout(this.reasonTimer);
      this.reasonTimer = window.setTimeout(() => { el.hidden = true; }, 9000);
    } else {
      this.showToast(text, true);
    }
    const bar = this.handBar;
    if (bar && !this.opts.reducedMotion) {
      bar.classList.remove("misfit");
      void bar.offsetWidth;                  // reflow to restart the shake (layout, not a clock)
      bar.classList.add("misfit");
      window.setTimeout(() => bar.classList.remove("misfit"), 500);
    } else if (bar) {
      bar.classList.add("misfit");            // reduced motion: the red edge is the whole message
      window.setTimeout(() => bar.classList.remove("misfit"), 1200);
    }
  }

  /* ------------------------------------------------- Art 5b: keyboard play ------ */

  /**
   * §7: arrows walk the campus without a pointer — first the vehicle (in engine road order), then
   * its bays as a sliding window (which is what a k-bay vehicle needs: k bays side by side);
   * Enter attempts the park (the engine decides), Esc clears. Every state change is announced
   * through the stage's existing polite live region.
   */
  private onCanvasKey(ev: KeyboardEvent): void {
    if (!this.handMode || this.finished || !this.pair) return;
    const road = this.pair.cur.queuedOrder;
    if (ev.key === "Escape") {
      ev.preventDefault();
      if (this.staged.length) this.staged = [];
      else {
        this.selected = null;
        this.kbVehicle = -1;
        this.kbBayOffset = 0;
      }
      this.repaint();
      this.showToast(this.selected ? `${this.selected} — bays cleared, press Time or choose a bay`
        : "nothing selected", false);
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (this.selected && this.staged.length) void this.placeSelected();
      else if (this.selected) this.stageWindow(0);
      else this.showToast("the road is empty — arrow keys choose a vehicle", false);
      return;
    }
    if (!ev.key.startsWith("Arrow")) return;
    ev.preventDefault();
    const dir = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : -1;
    if (!this.selected) {
      if (!road.length) { this.showToast("the road is empty — press Time to advance", false); return; }
      const at = this.kbVehicle + dir;
      this.kbVehicle = ((at % road.length) + road.length) % road.length;
      this.selected = road[this.kbVehicle] ?? null;
      this.kbBayOffset = 0;
      this.stageWindow(0);
      return;
    }
    this.kbBayOffset += dir;
    this.stageWindow(this.kbBayOffset);
  }

  /** Stage the FIFO hint when it has the right size, else the sliding bay window at `offset`. */
  private stageWindow(offset: number): void {
    const id = this.selected;
    if (!id) return;
    const job = this.snap?.jobs?.find((j) => j.id === id) ?? null;
    if (!job) { this.staged = []; this.repaint(); return; }
    const hinted = this.suggestions[id] ?? [];
    const nodes = Math.max(1, job.nodes ?? 1);
    this.staged = hinted.length === nodes ? [...hinted].sort()
      : this.bayWindow(this.candidateBays(), nodes, offset);
    this.repaint();
    const fit = this.stagedFits(job, this.staged) ? "would fit" : "would not fit";
    this.showToast(`${id} → ${this.staged.join(", ") || "no bays"} (${fit}). Enter parks it; `
      + `arrows move along the lot.`, false);
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

  /**
   * Tutorial `set_mode "step"` (Art 5b): drive the live campus one event batch at a time. Hand mode
   * has no booth to step (its clock is the `Time ▶` button), so this is a no-op there.
   */
  setStepMode(on: boolean): void {
    if (this.handMode || this.finished) return;
    if (on) {
      this.stepMode = true;
      this.paused = true;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.syncPauseButton();
      this.opts.onStatus?.("campus stepping — Step advances one event batch");
    } else if (this.stepMode) {
      this.stepMode = false;
      this.paused = false;
      this.syncPauseButton();
      this.rebase();
      this.request();
      this.opts.onStatus?.("campus running");
    }
  }

  /**
   * Tutorial `reveal {building: NAME}` (Art 6a): the building is already owned (the beat forced a
   * grant or a week-end took it) — revealing it flips its sprite from the dim `?` placeholder to
   * its real token, lands it with a pop, and repeats what it is. `revealedBuildings` only exists
   * while a tutorial manages the stage; elsewhere everything owned is revealed by default.
   */
  revealBuilding(name: string): void {
    if (name === "fairness") this.fairnessFlashed = true;   // the community board goes up
    this.revealedBuildings?.add(name);
    this.repaint();
    const def = this.buildingDefs.find((b) => b.id === name);
    if (!def) {
      this.setModeChip(`${name}: not on this campus yet`);
      return;
    }
    if (name === "reserve") {
      this.setModeChip("cones: place one");
      this.pulseAnchor("bays");
      this.showToast("Reservations: a cone books bays for a future vehicle without occupying them. "
        + "Choose a vehicle, then press Cone it.", false);
    } else {
      this.setModeChip(`${def.name}: on the campus`);
      this.showToast(`${def.name} — ${def.blurb}`, false);
    }
    this.pulseAnchor(`building:${name}`);
  }

  /**
   * The tutorial runner attached/detached (Art 6a). While managed, owned-but-unrevealed buildings
   * draw dimmed + `?` and the runner's `pick_of` beat opens the shared offers panel itself — the
   * campus suppresses its own auto-overlay (ONE panel, never two). On detach any unresolved frozen
   * week re-surfaces through the campus panel/hatch, so skipping a script cannot strand a freeze.
   */
  tutorialManaged(on: boolean): void {
    this.managedByTutorial = on;
    if (on) {
      if (!this.revealedBuildings) this.revealedBuildings = new Set();
      this.repaint();
      return;
    }
    this.revealedBuildings = null;
    this.repaint();
    if (this.weekFrozen && !this.weekPanel?.isOpen()) void this.openWeekOffers(this.frozenWeek);
  }

  /** The viewer-side cones on the map now (Art 5b hand hints; the engine has never seen them). */
  viewerCones(): { job: string; bays: string[] }[] {
    return this.handCones.map((c) => ({ job: c.job, bays: [...c.bays] }));
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
    if (name.startsWith("building:")) {
      // Art 6a: the sprite's own box (the sprite ∩ reveals list the scene already carries).
      const b = s.buildings.find((x) => x.id === name.slice(9));
      return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
    }
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
    this.weekPanel?.close();
    this.opts.container.textContent = "";
    this.fairnessCard?.remove();          // the rail is the shell's element — drop ours from it
    this.fairnessCard = null;
    this.fairnessList = null;
    this.fairnessEls.clear();
    this.fairnessParts.clear();
    if (this.railEl) this.railEl.hidden = true;
  }
}

function fmt(t: number): string {
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m`;
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}
