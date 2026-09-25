/**
 * The tutorial runner (Art 4): executes a city script from `tutorial_load` against a live hand
 * campus. Every trigger reads an ENGINE FACT from the snapshots the campus exposes (`onStep`) —
 * sim time, queue state, engine-provided `placed_total`/`week` (with derived fallbacks) — never
 * wall clock, so the guided sequence is as deterministic as the run itself (Concepts/Tutorial.md).
 *
 * Robustness contract ("never hang"): an unknown `when`/`do`/`wait_for` keyword warns on the
 * console and is treated as satisfied/skipped; every wait also carries a sim-time stall watchdog
 * (`max(2 x watch_plan.stride, 3600)` s); and a permanent, focusable "Skip tutorial" button ends
 * the script and unlocks the campus. A player can always get out.
 */

import { bridge, type Level, type StepState } from "./bridge";
import { buy as buyUpgrade, getProgression } from "./progression";
import { ruleCards, trapDialog } from "./booth";
import type { CampusPlay } from "./campus-play";

// --- the script shape (levels/tutorials/*.json, validated by scripts/check_tutorials.py) ----

export interface CalloutSpec {
  title?: string;
  body?: string;
  anchor?: string;
  actions?: string[];
}

export interface TutorialStep {
  id?: string;
  when?: Record<string, unknown>;
  do?: Record<string, unknown>[];
  then?: { wait_for?: Record<string, unknown>; end?: boolean }[];
}

export interface TutorialScript {
  version?: number;
  city?: number;
  title?: string;
  level: string;
  level_patch?: Record<string, unknown>;
  steps: TutorialStep[];
  end?: { on?: Record<string, unknown>; next?: number };
}

/**
 * Load a city script. Over HTTP first (`levels/tutorials/<city>.json`, served the same way level
 * JSON is — Pyodide cannot see repo files, so `tutorial_load` fails in the browser and works for
 * CLI/Node smoke), `bridge.tutorial_load` as the fallback. One script either way.
 */
async function loadScript(city: string): Promise<TutorialScript | null> {
  try {
    const response = await fetch(new URL(`levels/tutorials/${city}.json`, document.baseURI).href);
    if (response.ok) return (await response.json()) as TutorialScript;
  } catch {
    /* fall through to the bridge */
  }
  try {
    const { tutorial } = await bridge.tutorialLoad<TutorialScript>(city);
    return tutorial ?? null;
  } catch {
    return null;
  }
}

/**
 * A city's *edition* of its canonical level: fetch the level and apply the whitelisted patch
 * (the same `story`/`duration`/`generator` keys `sim/tutorial.py` enforces engine-side; the
 * merge only feeds data to Python, which still validates and decides everything).
 */
export async function cityLevel(city: string): Promise<{ level: Level; tutorial: TutorialScript } | null> {
  const tutorial = await loadScript(city);
  if (!tutorial?.level) return null;
  const response = await fetch(new URL(`levels/${tutorial.level}.json`, document.baseURI).href);
  if (!response.ok) throw new Error(`levels/${tutorial.level}.json: HTTP ${response.status}`);
  const base = (await response.json()) as Level;
  const level: Level = { ...base };
  const patch = tutorial.level_patch ?? {};
  for (const key of ["story", "duration", "generator"] as const) {
    if (!(key in patch)) continue;
    if (key === "generator") {
      level.generator = { ...(base.generator as object | undefined), ...(patch.generator as object | undefined) };
    } else level[key] = patch[key];
  }
  return { level, tutorial };
}

// --- the runner ------------------------------------------------------------------------------

type WaitResult = "ok" | "skip";

interface Waiter {
  /** "wait" while unsatisfied; otherwise the resolution. Evaluated only on engine snapshots. */
  probe: (now: number) => "wait" | WaitResult;
  resolve: (result: WaitResult) => void;
}

/** A queued vehicle waiting this long with nobody parked is "falling behind" (15 min). */
const BEHIND_WAIT_SECS = 900;
/** …and by this fraction of the horizon, however tidy, the week is nearly run: behind. */
const BEHIND_HORIZON_FRACTION = 0.6;

const OFFER_NAMES: Record<string, string> = {
  reserve: "Reservations", sensors: "Sensors", fairness: "Fairness",
  preempt: "Preemption", route: "Routing",
};

export interface TutorialOptions {
  onStatus?: (text: string) => void;
}

export class TutorialRunner {
  private readonly script: TutorialScript;
  private readonly stride: number;
  private readonly duration: number;
  private readonly stallAfter: number;
  private readonly events = new Set<string>();
  private now = 0;
  private day = 1;
  private week = 1;
  private placed = 0;
  private behind = false;
  private done = false;
  private abort = false;
  private lastPlacedId: string | null = null;
  private readonly submitOf = new Map<string, number>();
  private prevPressureMax = 0;
  private waiter: Waiter | null = null;
  private uiResolve: (() => void) | null = null;
  private readonly skipButton: HTMLButtonElement;
  private openUi: { close(): void } | null = null;
  private prevStepOnEvent: ((name: string) => void) | undefined;

  private constructor(
    _city: string,
    private readonly campus: CampusPlay,
    script: TutorialScript,
    private readonly options: TutorialOptions,
  ) {
    this.script = script;
    this.stride = campus.dayStride;
    this.duration = campus.durationSec;
    this.stallAfter = Math.max(2 * this.stride, 3600);
    this.skipButton = document.createElement("button");
    this.skipButton.type = "button";
    this.skipButton.className = "tutorial-skip";
    this.skipButton.textContent = "Skip tutorial";
    this.skipButton.addEventListener("click", () => this.skip());
    campus.stage.append(this.skipButton);
  }

  static async start(city = "city1", campus: CampusPlay, options: TutorialOptions = {}): Promise<TutorialRunner> {
    const tutorial = await loadScript(city);
    const runner = new TutorialRunner(city, campus, tutorial ?? { level: "level1", steps: [] }, options);
    runner.attach();
    return runner;
  }

  private attach(): void {
    this.prevStepOnEvent = this.campus.onEvent;
    this.campus.onEvent = (name) => {
      this.event(name);
      this.prevStepOnEvent?.(name);
    };
    this.campus.onStep = (state) => this.observe(state);
    // City 1 hides the booth until the script reveals it; from city 2 on the booth is a
    // standing part of the campus (city 2 opens with it staffed).
    if (this.campus.isHand && Number(this.script.city ?? 1) === 1) this.campus.revealBooth(false);
    void this.runLoop();
  }

  // --- the ledger: engine snapshots in, events out -------------------------------------------

  private observe(state: StepState): void {
    const now = state.now;
    this.now = now;
    this.day = Math.floor(now / this.stride) + 1;
    // Parallel engine work will carry week/placed_total on the snapshot; derive until it lands.
    const raw = state as StepState & { week?: number; placed_total?: number;
                                        unseen?: { id: string; submit: number }[] };
    this.week = raw.week ?? Math.floor(now / (7 * this.stride)) + 1;
    for (const u of raw.unseen ?? []) if (!this.submitOf.has(u.id)) this.submitOf.set(u.id, u.submit);
    for (const id of state.queued) if (!this.submitOf.has(id)) this.submitOf.set(id, now);
    const placedTotal = raw.placed_total ?? state.finished + state.running.length;
    if (placedTotal > this.placed) {
      this.event("first_place");
      const justPlaced = state.running.filter((r) => r.start === now).map((r) => r.id).sort();
      if (justPlaced.length) this.lastPlacedId = justPlaced[justPlaced.length - 1] ?? this.lastPlacedId;
    }
    this.placed = placedTotal;
    const pressureValues = Object.values(state.pressure ?? {});
    const pressureMax = pressureValues.length ? Math.max(...pressureValues) : 0;
    if (pressureMax > this.prevPressureMax + 0.001) this.event("pressure_moved");
    this.prevPressureMax = pressureMax;
    if (state.overflow) this.event("overflow");
    if (state.queued.some((id) => now - (this.submitOf.get(id) ?? now) > BEHIND_WAIT_SECS)
        || pressureMax >= 0.75 || !!state.overflow || state.queued.length >= 3
        || (this.duration > 0 && now >= BEHIND_HORIZON_FRACTION * this.duration)) {
      this.behind = true;
    }
    if (this.week > 1 || (this.duration > 0 && now >= this.duration) || state.done) {
      this.event("week_end");
    }
    this.done = this.done || state.done;
    this.checkWaiter();
  }

  private event(name: string): void {
    if (this.events.has(name)) return;
    this.events.add(name);
    this.checkWaiter();
  }

  // --- predicates ---------------------------------------------------------------------------

  /** Evaluate a `when`/`wait_for` object: every key must hold (AND of atoms). */
  private cond(condition: Record<string, unknown> | undefined): boolean {
    if (!condition) return true;
    return Object.entries(condition).every(([kind, value]) => this.atom(kind, value, this.now));
  }

  /** One predicate atom; `start` is the wait-start baseline for the delta predicates. */
  private atom(kind: string, value: unknown, start: number, startPlaced = -1): boolean {
    switch (kind) {
      case "after_days": return this.day > Number(value);   // day is 1-indexed: after day 0 = now
      case "after_sim_secs": return this.now >= Number(value);
      case "on_event": return this.events.has(String(value));
      case "first_time": return this.events.has(String(value));
      case "all": return Array.isArray(value) && value.every((c) => this.cond(c as Record<string, unknown>));
      case "once": return true;                             // handled by running each step once
      case "behind": return this.behind;
      case "placed_any": return startPlaced >= 0 ? this.placed > startPlaced : this.placed > 0;
      case "sim_secs": return this.now >= start + Number(value);
      case "week_end": return this.events.has("week_end");
      case "booth_staffed": return this.events.has("booth_staffed");
      case "card_swapped": return this.events.has("card_swapped");
      case "line_edited": return this.events.has("line_edited");
      case "cards_placed": return ruleCards(this.campus.boothKata()).length >= Number(value);
      case "day": return this.day >= Number(value);
      case "chosen": return this.campus.currentScene()?.chosen != null;
      default:
        console.warn(`tutorial: unknown predicate "${kind}" — treated as satisfied`);
        return true;
    }
  }

  // --- waiting (every wait also carries the stall watchdog) -----------------------------------

  private wait(probe: (now: number) => "wait" | WaitResult): Promise<WaitResult> {
    if (this.abort) return Promise.resolve("skip");
    return new Promise<WaitResult>((resolve) => {
      const wrapped: Waiter = {
        resolve: (result) => {
          if (this.waiter === wrapped) this.waiter = null;
          resolve(result);
        },
        probe: (now) => {
          const verdict = probe(now);
          if (verdict === "wait" && now >= this.waitStart + this.stallAfter) {
            console.warn("tutorial: wait stalled past its watchdog — moving on");
            return "ok";
          }
          return verdict;
        },
      };
      this.waiter = wrapped;
      this.checkWaiter();
    });
  }

  private waitStart = 0;

  private checkWaiter(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    const verdict = waiter.probe(this.now);
    if (verdict !== "wait") waiter.resolve(verdict);
  }

  // --- the step loop ------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    const steps = this.script.steps ?? [];
    for (let i = 0; i < steps.length; i++) {
      if (this.abort) return;
      const step = steps[i]!;
      this.waitStart = this.now;
      const gate = await this.wait((now) => {
        void now;
        return this.cond(step.when) ? "ok" : "wait";
      });
      if (this.abort || gate === "skip") return;
      for (const action of step.do ?? []) {
        if (this.abort) return;
        await this.doAction(action);
      }
      for (const next of step.then ?? []) {
        if (this.abort) return;
        if (next.end) {
          this.finish("tutorial complete");
          return;
        }
        const spec = next.wait_for ?? {};
        this.waitStart = this.now;
        const startPlaced = this.placed;
        const nextWhen = steps[i + 1]?.when;
        const result = await this.wait((now) => {
          const main = Object.entries(spec)
            .every(([kind, value]) => kind === "timeout_secs" || kind === "or_then"
              ? true : this.atom(kind, value, this.waitStart, startPlaced));
          if (main) return "ok";
          if (spec.timeout_secs !== undefined && now >= this.waitStart + Number(spec.timeout_secs)) {
            console.info(`tutorial: wait_for ${JSON.stringify(spec)} timed out — continuing`);
            return "ok";
          }
          if (spec.or_then && this.cond(nextWhen)) return "ok";
          return "wait";
        });
        if (result === "skip") return;
      }
    }
    this.finish("tutorial complete");
  }

  private async doAction(action: Record<string, unknown>): Promise<void> {
    if ("lock" in action) {
      const kind = String(action.lock);
      this.campus.setLock(kind === "hand" || kind === "place" || kind === "booth" ? kind : "none");
      return;
    }
    if (action.callout) {
      await this.callout(action.callout as CalloutSpec);
      return;
    }
    if (action.reveal) {
      const reveal = action.reveal as Record<string, unknown>;
      if (reveal.booth) this.campus.revealBooth(true);
      else console.warn(`tutorial: reveal ${Object.keys(reveal).join(",")} is engine-visible already`);
      return;
    }
    if (action.set_mode) {
      const mode = String(action.set_mode);
      this.campus.setModeChip(mode === "hand" ? "traffic: by hand" : `booth: ${mode.split(":")[1] ?? mode}`);
      // Art 5: the booth modes open the panel they name — `booth:line` straight into the
      // one-line editor (city 2's "the card IS the kata" beat).
      if (mode === "booth:cards") this.campus.openBoothPanel({});
      else if (mode === "booth:line") this.campus.openBoothPanel({ mode: "line" });
      return;
    }
    if ("swap_card" in action) {
      // Art 5: open the booth with the slot picker, pulsing the target slot (default: order).
      const spec = action.swap_card;
      const slot = typeof spec === "object" && spec !== null
        ? String((spec as Record<string, unknown>).slot ?? "order")
        : "order";
      this.campus.openBoothPanel({ slot });
      return;
    }
    if ("edit_line" in action) {
      // Art 5: open the booth in one-line mode, focused on the named card's line.
      const spec = action.edit_line;
      const o = (typeof spec === "object" && spec !== null
        ? spec
        : { card: spec }) as Record<string, unknown>;
      this.campus.openBoothPanel({
        mode: "line",
        slot: typeof o.slot === "string" ? o.slot : undefined,
        card: typeof o.card === "string" ? o.card : undefined,
      });
      return;
    }
    if (action.offer_upgrade) {
      await this.offers();
      return;
    }
    if ("highlight" in action) {
      // Art 5: pulse a scene anchor (Concepts/Campus scene vocabulary) — a nudge, not a gate.
      const spec = action.highlight;
      const target = typeof spec === "string" ? spec
        : String((spec as Record<string, unknown> | undefined)?.target ?? "");
      if (!this.campus.pulseAnchor(target)) {
        console.warn(`tutorial: highlight "${target}" has no scene anchor — skipped`);
      }
      return;
    }
    console.warn(`tutorial: unknown do "${Object.keys(action).join(",")}" — skipped`);
  }

  // --- scripted UI (static popovers; focus-trapped per Concepts/Accessibility) ---------------

  private callout(spec: CalloutSpec): Promise<void> {
    if (this.abort) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const host = this.campus.stage;
      const overlay = document.createElement("div");
      overlay.className = "callout-overlay";
      const panel = document.createElement("section");
      panel.className = "callout-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "tutorial-callout-title");
      const title = document.createElement("h3");
      title.id = "tutorial-callout-title";
      title.textContent = spec.title ?? "Tutorial";
      const body = document.createElement("p");
      body.textContent = spec.body ?? "";
      const actions = document.createElement("div");
      actions.className = "callout-actions";
      panel.append(title, body, actions);
      overlay.append(panel);
      host.append(overlay);
      for (const label of spec.actions?.length ? spec.actions : ["OK"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => close());
        actions.append(button);
      }
      const anchor = spec.anchor
        ? this.campus.anchorPoint(spec.anchor, this.lastPlacedId)
        : null;
      const box = host.getBoundingClientRect();
      const at = anchor ?? { x: box.width / 2, y: box.height * 0.4 };
      panel.style.left = `${Math.max(8, Math.min(box.width - 260, at.x - 120))}px`;
      panel.style.top = `${Math.max(8, Math.min(box.height - 120, at.y - 24))}px`;
      const previously = document.activeElement as HTMLElement | null;
      panel.tabIndex = -1;
      (actions.querySelector("button") ?? panel).focus();
      trapDialog(panel, () => close());
      const close = (): void => {
        if (!overlay.isConnected) return;
        overlay.remove();
        this.openUi = null;
        this.uiResolve = null;
        previously?.focus?.();
        resolve();
      };
      this.openUi = { close };
      this.uiResolve = () => close();
    });
  }

  /** `offer_upgrade`: the deterministic weekly pair from `offers_list`, take-one. */
  private async offers(): Promise<void> {
    let ids: string[] = [];
    try {
      const res = await bridge.offersList(getProgression(), this.script.city ?? 1, this.week);
      ids = res.offers ?? [];
    } catch (error) {
      console.warn("tutorial: offers_list failed", error);
      return;
    }
    await new Promise<void>((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "callout-overlay";
      const panel = document.createElement("section");
      panel.className = "callout-panel offers-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "tutorial-offers-title");
      const title = document.createElement("h3");
      title.id = "tutorial-offers-title";
      title.textContent = "End of week one — take one upgrade";
      const list = document.createElement("div");
      list.className = "offers-list";
      const note = document.createElement("div");
      note.className = "offers-note";
      note.setAttribute("role", "status");
      panel.append(title, list, note);
      overlay.append(panel);
      this.campus.stage.append(overlay);
      for (const id of ids.length ? ids : ["reserve", "sensors"]) {
        const card = document.createElement("div");
        card.className = "offer-card";
        const name = document.createElement("b");
        name.textContent = OFFER_NAMES[id] ?? id;
        const take = document.createElement("button");
        take.type = "button";
        take.textContent = "Take";
        take.addEventListener("click", () => {
          void this.takeUpgrade(id).then((message) => {
            note.textContent = message;
          });
        });
        card.append(name, take);
        list.append(card);
      }
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Done";
      close.addEventListener("click", () => dismiss());
      list.append(close);
      const previously = document.activeElement as HTMLElement | null;
      close.focus();
      trapDialog(panel, () => dismiss());
      const dismiss = (): void => {
        if (!overlay.isConnected) return;
        overlay.remove();
        this.openUi = null;
        this.uiResolve = null;
        previously?.focus?.();
        resolve();
      };
      this.openUi = { close: dismiss };
      this.uiResolve = () => dismiss();
    });
  }

  private async takeUpgrade(id: string): Promise<string> {
    try {
      await buyUpgrade(id);
      return `${OFFER_NAMES[id] ?? id} taken.`;
    } catch {
      return `${OFFER_NAMES[id] ?? id} is not buyable yet — earn credits; this week passes.`;
    }
  }

  // --- the escape hatch ---------------------------------------------------------------------

  skip(): void {
    this.finish("tutorial skipped");
  }

  destroy(): void {
    if (!this.abort) this.finish("tutorial ended");
    this.skipButton.remove();
  }

  private finish(status: string): void {
    if (this.abort) return;
    this.abort = true;
    this.uiResolve?.();
    this.openUi?.close();
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve("skip");
    this.campus.revealBooth(true);
    this.campus.setLock("none");
    this.campus.setModeChip("");
    this.skipButton.remove();
    this.campus.onStep = undefined;
    this.campus.onEvent = this.prevStepOnEvent;
    this.options.onStatus?.(status);
  }
}
