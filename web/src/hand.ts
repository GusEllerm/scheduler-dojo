/**
 * Stage 5 "hand placement": the player drives a manual run.
 *
 * Everything is DOM (chips + lanes), not canvas — the canvas timeline only appears at Finish, fed
 * by `bridge.handResult` plus the client-side placement map so lanes show the *real* node ids.
 *
 * Interaction model (click-to-place is the reliable path; HTML5 drag mirrors it):
 *   1. click a queued-job chip (or drag it) to select the job;
 *   2. click N node lanes to stage them (click again to unstage) — a drop behaves like a click;
 *   3. "Place" calls `hand_place(handle, jobId, [nodes])`. The engine VALIDATES everything and may
 *      answer `{ok:false, error:{code,message}}` — shown as an inline toast, the run stays alive
 *      and the selection stays staged so the player can fix it (e.g. add the second node).
 * "Next" calls `hand_tick` (one arrival/finish batch); "Finish" calls `hand_result`, records the
 * score through `persistence.recordFinish`, and paints the completed timeline.
 *
 * The score the engine's `hand_result` does not return (it mirrors `step_result`), is computed
 * client-side with an exact mirror of `scoring.score` — same weights/anchors from the level.
 */

import {
  bridge,
  BridgeError,
  type HandSuggestions,
  type Level,
  type Metrics,
  type NodeInfo,
  type RunResult,
  type StepState,
} from "./bridge";
import { mountGauges, type GaugesHandle } from "./gauges";
import { recordFinish } from "./persistence";
import { formatTime, mountTimeline, type TimelineHandle } from "./render/timeline";

export interface HandGameOptions {
  level: Level;
  seed?: number | null;
  /** Where the queue strip + node lanes + toolbar live (rebuilt on destroy). */
  container: HTMLElement;
  /** Where the live gauges mount. */
  gauges: HTMLElement;
  /** Where the finished timeline paints on Finish. */
  timeline: HTMLElement;
  /** Called once with the final RunResult (after persistence has been written). */
  onFinished?: (run: RunResult) => void;
}

interface ScoreAnchor {
  baseline?: number;
  reference?: number;
  higher_better?: boolean;
}

export class HandGame {
  private readonly root: HTMLElement;
  private readonly toastBox: HTMLElement;
  private readonly queueStrip: HTMLElement;
  private readonly lanesBox: HTMLElement;
  private readonly staging: HTMLElement;
  private readonly stagingText: HTMLElement;
  private readonly placeButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly finishButton: HTMLButtonElement;
  private readonly hintBox: HTMLInputElement;
  private readonly clock: HTMLElement;
  private readonly gauges: GaugesHandle;
  private laneRows = new Map<string, HTMLElement>();

  private handle = 0;
  private nodes: NodeInfo[] = [];
  private state: StepState | null = null;
  private suggestions: HandSuggestions = {};
  private selected: string | null = null;
  private staged: string[] = [];
  private busy = false;
  private finished = false; // hand_result consumed
  private toastTimer = 0;
  private readonly placements: Record<string, string[]> = {};
  private resultTimeline: TimelineHandle | null = null;

  private constructor(readonly options: HandGameOptions) {
    this.root = buildShell(options.container);
    this.toastBox = child(this.root, "hand-toast");
    const toolbar = child(this.root, "hand-toolbar");
    this.nextButton = button(toolbar, "Next ▸ (advance time)", () => void this.tick());
    this.finishButton = button(toolbar, "Finish", () => void this.finish());
    this.clock = span(toolbar, "hand-clock");
    const hint = label(toolbar, "hints");
    this.hintBox = hint.input;
    this.hintBox.addEventListener("change", () => this.render());
    this.staging = child(this.root, "hand-staging");
    this.stagingText = span(this.staging, "hand-staging-text");
    this.placeButton = button(this.staging, "Place", () => void this.place());
    this.cancelButton = button(this.staging, "cancel", () => this.clearSelection());
    this.queueStrip = child(this.root, "hand-queue");
    this.lanesBox = child(this.root, "hand-lanes");
    this.gauges = mountGauges(options.gauges);
    this.render();
  }

  /** Start a hand run: `hand_start`, then wire the node lanes and first render. */
  static async create(options: HandGameOptions): Promise<HandGame> {
    const game = new HandGame(options);
    try {
      const started = await bridge.handStart(options.level, options.seed ?? null);
      game.handle = started.handle;
      game.nodes = started.nodes;
      game.suggestions = started.suggestions ?? {};
      game.buildLanes();
      game.apply(started.state);
    } catch (error) {
      game.toast(error);
    }
    return game;
  }

  destroy(): void {
    window.clearTimeout(this.toastTimer);
    this.resultTimeline?.destroy();
    this.resultTimeline = null;
    this.gauges.destroy();
    this.root.remove();
  }

  // --- actions ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.busy || this.finished) return;
    this.busy = true;
    this.nextButton.disabled = true;
    try {
      const res = await bridge.handTick(this.handle);
      this.suggestions = res.suggestions ?? {};
      this.apply(res.state);
      if (res.done) this.info("No events left — press Finish to score the run.");
    } catch (error) {
      this.toast(error);
    } finally {
      this.busy = false;
      this.nextButton.disabled = this.finished;
    }
  }

  private async place(): Promise<void> {
    if (this.busy || this.finished || !this.selected || !this.staged.length) return;
    const job = this.selected;
    const nodes = [...this.staged];
    this.busy = true;
    try {
      const res = await bridge.handPlace(this.handle, job, nodes);
      this.apply(res.state);
      if (res.ok) {
        this.placements[job] = nodes;
        this.hideToast();
        this.clearSelection();
      } else if (res.error) {
        // Keep the selection staged: e.g. "needs 2 nodes, got 1" is fixed by staging one more.
        this.toastText(res.error.code, res.error.message);
      }
    } catch (error) {
      this.toast(error);
    } finally {
      this.busy = false;
    }
  }

  private async finish(): Promise<void> {
    if (this.busy || this.finished) return;
    this.busy = true;
    this.finishButton.disabled = true;
    try {
      const res = await bridge.handResult(this.handle);
      this.finished = true;
      const level = this.options.level;
      const seed = Number(level.seed ?? 0);
      const weights = (level.score_weights ?? {}) as Record<string, number>;
      const anchors = (level.score_anchors ?? {}) as Record<string, ScoreAnchor>;
      const bars = level.bars as { pass_score?: number; gold_score?: number } | undefined;
      const score =
        Object.keys(weights).length && Object.keys(anchors).length
          ? scoreFromMetrics(res.metrics, weights, anchors)
          : undefined;
      const run: RunResult = {
        level_id: level.id === undefined ? undefined : String(level.id),
        seed,
        policy: "hand",
        nodes: this.nodes,
        jobs: res.jobs,
        end_time: res.end_time,
        n_jobs: res.jobs.length,
        node_seconds_busy: 0,
        node_seconds_total: 0,
        metrics: res.metrics,
        trajectory_hash: res.trajectory_hash,
        ...(score !== undefined ? { score } : {}),
        ...(bars ? { bars } : {}),
      };
      recordFinish(String(level.id ?? "level"), seed, score, score !== undefined && score >= (bars?.gold_score ?? Infinity));
      this.render();
      this.info(`Run finished at ${formatTime(res.end_time)} — the timeline below shows your placements.`);
      this.resultTimeline?.destroy();
      this.resultTimeline = mountTimeline(this.options.timeline, run, {
        placements: this.placements,
        horizon: Number(level.duration ?? 0) || undefined,
      });
      this.options.onFinished?.(run);
    } catch (error) {
      this.toast(error);
      this.finishButton.disabled = false;
    } finally {
      this.busy = false;
    }
  }

  // --- selection / staging -----------------------------------------------------------------

  private select(jobId: string): void {
    if (this.finished) return;
    this.selected = this.selected === jobId ? null : jobId;
    this.staged = [];
    this.render();
  }

  private toggleNode(nodeId: string): void {
    if (this.finished || !this.selected) return;
    const at = this.staged.indexOf(nodeId);
    if (at >= 0) this.staged.splice(at, 1);
    else this.staged.push(nodeId);
    this.render();
  }

  private clearSelection(): void {
    this.selected = null;
    this.staged = [];
    this.render();
  }

  // --- rendering ---------------------------------------------------------------------------

  private apply(state: StepState): void {
    this.state = state;
    this.gauges.update(state);
    this.render();
  }

  private buildLanes(): void {
    this.lanesBox.textContent = "";
    this.laneRows = new Map();
    for (const node of this.nodes) {
      const row = document.createElement("div");
      row.className = "hand-lane";
      row.dataset.node = node.id;
      const name = document.createElement("span");
      name.className = "hand-lane-name";
      name.textContent = `${node.name || node.id} · ${node.cpus}c${node.gpus ? ` ${node.gpus}g` : ""}`;
      const track = document.createElement("div");
      track.className = "hand-lane-track";
      row.append(name, track);
      row.addEventListener("click", () => this.toggleNode(node.id));
      row.addEventListener("dragover", (event) => {
        if (this.selected) event.preventDefault();
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        this.toggleNode(node.id);
      });
      this.lanesBox.append(row);
      this.laneRows.set(node.id, row);
    }
  }

  private render(): void {
    const state = this.state;
    this.nextButton.disabled = this.finished || !state;
    this.finishButton.disabled = this.finished;
    this.cancelButton.disabled = this.finished;
    this.hintBox.disabled = this.finished;
    if (!state) {
      this.clock.textContent = "starting…";
      return;
    }
    this.clock.textContent = `t=${formatTime(state.now)} · queued ${state.queued.length} · running ${state.running.length} · done ${state.finished}`;

    // Queue strip: draggable chips; click selects, dragstart also selects.
    this.queueStrip.replaceChildren(
      ...state.queued.map((id) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = id === this.selected ? "hand-chip selected" : "hand-chip";
        chip.textContent = id;
        chip.title = "click to select, then click node lanes (or drag onto one)";
        chip.draggable = !this.finished;
        chip.addEventListener("click", () => this.select(id));
        chip.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData("text/plain", id);
          if (this.selected !== id) this.select(id);
        });
        return chip;
      }),
    );

    // Lanes: occupancy + staging + hint outlines.
    const jobsByNode = new Map<string, { id: string; start: number }[]>();
    for (const job of state.running) {
      for (const nid of job.nodes) {
        const list = jobsByNode.get(nid) ?? [];
        list.push({ id: job.id, start: job.start ?? state.now });
        jobsByNode.set(nid, list);
      }
    }
    const hinted = new Set<string>();
    const hintedForSelected = new Set<string>();
    if (this.hintBox.checked) {
      for (const [jobId, nodes] of Object.entries(this.suggestions)) {
        for (const nid of nodes) {
          hinted.add(nid);
          if (jobId === this.selected) hintedForSelected.add(nid);
        }
      }
    }
    for (const [nid, row] of this.laneRows) {
      const running = jobsByNode.get(nid) ?? [];
      row.classList.toggle("busy", running.length > 0);
      row.classList.toggle("staged", this.staged.includes(nid));
      row.classList.toggle("selectable", this.selected !== null && running.length === 0);
      row.classList.toggle("hint", hinted.has(nid));
      row.classList.toggle("hint-selected", hintedForSelected.has(nid));
      const track = row.querySelector(".hand-lane-track");
      if (track) {
        track.replaceChildren(
          ...running.map((job) => {
            const badge = document.createElement("span");
            badge.className = "hand-lane-job";
            badge.textContent = `${job.id} @${formatTime(job.start)}`;
            return badge;
          }),
        );
      }
    }

    // Staging bar.
    this.staging.classList.toggle("active", this.selected !== null && !this.finished);
    this.stagingText.textContent = this.selected
      ? `place ${this.selected} → ${this.staged.length ? this.staged.join(", ") : "click N free node lanes"}`
      : "";
    this.placeButton.disabled = this.finished || !this.selected || !this.staged.length;
  }

  // --- toast -------------------------------------------------------------------------------

  private toast(error: unknown): void {
    if (error instanceof BridgeError) this.toastText(error.code, error.message);
    else this.toastText("hand", error instanceof Error ? error.message : String(error));
  }

  private toastText(code: string, message: string): void {
    this.toastBox.className = "hand-toast error";
    this.toastBox.textContent = "";
    const b = document.createElement("b");
    b.textContent = String(code);
    this.toastBox.append(b, ` ${message}`);
    this.toastBox.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideToast(), 8000);
  }

  private info(message: string): void {
    this.toastBox.className = "hand-toast info";
    this.toastBox.textContent = message;
    this.toastBox.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideToast(), 5000);
  }

  private hideToast(): void {
    this.toastBox.hidden = true;
    this.toastBox.textContent = "";
  }
}

// --- DOM helpers + client-side score mirror ------------------------------------------------

function buildShell(container: HTMLElement): HTMLElement {
  container.textContent = "";
  const root = document.createElement("div");
  root.className = "hand";
  container.append(root);
  return root;
}

function child(parent: HTMLElement, className: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  parent.append(node);
  return node;
}

function span(parent: HTMLElement, className: string): HTMLElement {
  const node = document.createElement("span");
  node.className = className;
  parent.append(node);
  return node;
}

function button(parent: HTMLElement, text: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "hand-button";
  node.textContent = text;
  node.addEventListener("click", onClick);
  parent.append(node);
  return node;
}

function label(parent: HTMLElement, text: string): { input: HTMLInputElement } {
  const wrap = document.createElement("label");
  wrap.className = "hand-hint-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  wrap.append(input, document.createTextNode(text));
  parent.append(wrap);
  return { input };
}

/** Exact mirror of `scheduler_dojo.sim.scoring.score` (see its module docstring). */
export function scoreFromMetrics(
  metrics: Metrics,
  weights: Record<string, number>,
  anchors: Record<string, ScoreAnchor>,
): number {
  const entries = metrics as unknown as Record<string, number>;
  const members = Object.keys(entries)
    .filter((m) => m in weights)
    .sort();
  let weightTotal = 0;
  for (const m of members) weightTotal += weights[m] ?? 0;
  let blend = 0;
  if (members.length && weightTotal !== 0) {
    let sum = 0;
    for (const m of members) {
      const anchor = anchors[m] ?? {};
      const b = anchor.baseline ?? 0;
      const r = anchor.reference ?? 0;
      const higherBetter = anchor.higher_better ?? true;
      const value = entries[m] ?? 0;
      const norm = r === b ? 0 : higherBetter ? (value - b) / (r - b) : (b - value) / (b - r);
      sum += (weights[m] ?? 0) * norm;
    }
    blend = sum / weightTotal;
  }
  return Math.max(0, Math.min(1000, Math.round(300 + 500 * blend)));
}
