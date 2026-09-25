/**
 * Stage 6 "Write a kata" (levels 3-5): editor -> check -> run -> step -> timeline.
 *
 * - Check  → `bridge.checkKata`: errors paint inline in the editor + a list under the toolbar.
 * - Run    → `bridge.runLevel(level, {kata})`: the full run payload paints the same canvas timeline
 *   the watch mode uses, plus a scorecard with the level's pass/gold bars. When the score clears
 *   the pass bar the finish is stored through `persistence.recordFinish` (best/gold per seed).
 * - Step   → `bridge.startRun(level, {kata})` once, then `bridge.stepUntil(handle, t)` advances one
 *   job-boundary (next start/end from the preview run) per click, seeking the paused timeline to
 *   `state.now`; the last step finalizes via `bridge.stepResult` and records like Run.
 */

import { bridge, type KataError, type Level, type RunResult } from "./bridge";
import { mountKataEditor, type KataEditorHandle } from "./kata-editor";
import { loadKataText, mountKataLibrary, type KataEntry } from "./library";
import { levelProgress, recordFinish } from "./persistence";
import { formatTime, mountTimeline, type TimelineHandle } from "./render/timeline";

export interface KataPlayOptions {
  /** Where the timeline paints (the shared #timeline panel). */
  timeline: HTMLElement;
  /** Optional hook: called with every successful run (main.ts mirrors it into the global readout). */
  onRun?: (run: RunResult) => void;
  /** Art 4: the kata chosen at the campus booth — preselects the editor over the reference. */
  initialKata?: string;
}

export interface KataPlayHandle {
  destroy(): void;
}

export function mountKataPlay(container: HTMLElement, level: Level, options: KataPlayOptions): KataPlayHandle {
  container.textContent = "";

  // --- DOM ---------------------------------------------------------------------------
  const root = document.createElement("div");
  root.className = "kata-play";
  const libraryBox = document.createElement("aside");
  libraryBox.className = "kata-library";
  const mainBox = document.createElement("div");
  mainBox.className = "kata-main";

  const toolbar = document.createElement("div");
  toolbar.className = "kata-toolbar";
  const checkButton = toolButton(toolbar, "Check", "check_kata — validate without running");
  const runButton = toolButton(toolbar, "Run", "run the level under this kata");
  const stepButton = toolButton(toolbar, "Step ▸", "step_until through the run one event at a time");
  const status = document.createElement("span");
  status.className = "kata-status";
  toolbar.append(status);

  const editorBox = document.createElement("div");
  editorBox.className = "kata-editor-box";
  const errorList = document.createElement("ul");
  errorList.className = "kata-errors";
  const scorecard = document.createElement("div");
  scorecard.className = "kata-scorecard";
  const stepLine = document.createElement("div");
  stepLine.className = "kata-step-line";
  scorecard.append(stepLine);

  mainBox.append(toolbar, editorBox, errorList, scorecard);
  root.append(libraryBox, mainBox);
  container.append(root);

  const editor: KataEditorHandle = mountKataEditor(editorBox, "");
  mountKataLibrary(libraryBox, (entry) => void load(entry));

  // --- state -------------------------------------------------------------------------
  let timeline: TimelineHandle | null = null;
  let preview: RunResult | null = null;
  let stepHandle = 0;
  let stepNow = 0;
  let busy = false;
  const horizon = Number(level.duration ?? 0) || undefined;
  const levelId = String(level.id ?? "level");

  // Start from the level's reference kata so the first Run is instructive; a booth-staffing
  // choice (Art 4) wins, applied after the reference so the two loads never race.
  const reference = typeof level.reference_kata === "string" ? level.reference_kata : null;
  void (reference
    ? loadKataText({ name: "reference", blurb: "", path: reference })
        .then((text) => editor.setValue(text))
        .catch(() => undefined)
    : Promise.resolve()
  ).then(() => {
    if (options.initialKata !== undefined) editor.setValue(options.initialKata);
  });

  async function load(entry: KataEntry): Promise<void> {
    try {
      editor.setValue(await loadKataText(entry));
      setStatus(`loaded ${entry.name}`, "ok");
      errorList.replaceChildren();
    } catch (error) {
      setStatus(String(error), "bad");
    }
  }

  // --- actions -----------------------------------------------------------------------
  checkButton.addEventListener("click", () => void check());
  runButton.addEventListener("click", () => void run());
  stepButton.addEventListener("click", () => void step());

  async function check(): Promise<boolean> {
    const report = await bridge.checkKata(editor.getValue());
    const errors = normalizeErrors(report.errors);
    editor.showErrors(errors);
    paintErrorList(errors);
    if (report.ok) {
      setStatus("kata ok — no errors", "ok");
      return true;
    }
    setStatus(`${errors.length} error${errors.length === 1 ? "" : "s"} (see editor)`, "bad");
    return false;
  }

  async function run(autoplay = true): Promise<RunResult | null> {
    if (busy) return null;
    busy = true;
    setBusy(true);
    try {
      if (!(await check())) return null;
      const kata = editor.getValue();
      const result = await bridge.runLevel(level, { policy: "kata", kata });
      preview = result;
      resetStep();
      paintTimeline(result, autoplay);
      paintScorecard(result);
      options.onRun?.(result);
      setStatus(`run ok — seed ${result.seed}`, "ok");
      return result;
    } catch (error) {
      setStatus(describe(error), "bad");
      return null;
    } finally {
      busy = false;
      setBusy(false);
    }
  }

  async function step(): Promise<void> {
    if (busy) return;
    busy = true;
    setBusy(true);
    try {
      if (stepHandle === 0) {
        // First click: validate, get a static preview run for the lanes, open a stepping session.
        if (!(await check())) return;
        const kata = editor.getValue();
        preview = await bridge.runLevel(level, { policy: "kata", kata });
        const started = await bridge.startRun(level, { policy: "kata", kata });
        stepHandle = started.handle;
        stepNow = started.state.now;
        paintTimeline(preview, false);
        timeline?.seek(stepNow);
        paintStepState(started.state);
        setStatus(`stepping from t=${formatTime(stepNow)} — Step again to advance`, "ok");
        return;
      }
      if (!preview) return;
      const boundaries = eventTimes(preview).filter((t) => t > stepNow + 0.5);
      const target = boundaries.length ? boundaries[0]! : Number(preview.end_time) + 1;
      const res = await bridge.stepUntil(stepHandle, Math.ceil(target));
      stepNow = res.state.now;
      timeline?.seek(stepNow);
      paintStepState(res.state);
      if (res.done) {
        const final = await bridge.stepResult(stepHandle);
        stepHandle = 0;
        const run_: RunResult = { ...preview, ...final };
        preview = run_;
        paintTimeline(run_, false);
        timeline?.seek(run_.end_time);
        paintScorecard(run_);
        options.onRun?.(run_);
        setStatus("step run finished — scored below", "ok");
      } else {
        setStatus(`stepped to t=${formatTime(stepNow)}`, "ok");
      }
    } catch (error) {
      resetStep();
      setStatus(describe(error), "bad");
    } finally {
      busy = false;
      setBusy(false);
    }
  }

  function resetStep(): void {
    stepHandle = 0;
    stepNow = 0;
  }

  // --- painting ----------------------------------------------------------------------
  function paintTimeline(run: RunResult, autoplay: boolean): void {
    timeline?.destroy();
    timeline = mountTimeline(options.timeline, run, { autoplay, horizon });
    if (!autoplay) timeline.seek(0);
  }

  function paintStepState(state: { now: number; queued: string[]; running: unknown[]; finished: number }): void {
    stepLine.textContent = `t=${formatTime(state.now)} · queued ${state.queued.length} · running ${state.running.length} · finished ${state.finished}`;
  }

  function paintErrorList(errors: readonly KataError[]): void {
    errorList.replaceChildren(
      ...errors.map((error) => {
        const li = document.createElement("li");
        li.className = "kata-error";
        const b = document.createElement("b");
        b.textContent = `${error.line ?? "?"}: ${error.code}`;
        li.append(b, ` ${error.message}`);
        li.title = "click to jump there";
        li.addEventListener("click", () => {
          if (error.line) {
            const line = editor.view.state.doc.line(Math.min(error.line, editor.view.state.doc.lines));
            editor.view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
            editor.view.focus();
          }
        });
        return li;
      }),
    );
  }

  function paintScorecard(run: RunResult): void {
    scorecard.textContent = "";
    const bars = run.bars ?? (level.bars as RunResult["bars"] | undefined);
    const stats: [string, string][] = [
      ["score", run.score === undefined ? "—" : String(run.score)],
      ["utilization", `${(run.metrics.utilization * 100).toFixed(1)}%`],
      ["bounded slowdown", run.metrics.bounded_slowdown.toFixed(2)],
      ["wait p95", formatTime(run.metrics.wait_p95)],
      ["fairness", run.metrics.fairness.toFixed(3)],
      ["jobs", String(run.n_jobs)],
      ["horizon", formatTime(run.end_time)],
    ];
    const statBox = document.createElement("div");
    statBox.className = "readout";
    statBox.replaceChildren(
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
    scorecard.append(statBox);

    // Pass/gold bars: a track with tick markers at the two bar scores and a fill at the run score.
    if (bars) {
      const pass = Number(bars.pass_score ?? 0);
      const gold = Number(bars.gold_score ?? 0);
      const score = run.score ?? 0;
      const max = Math.max(1000, pass, gold, score);
      const track = document.createElement("div");
      track.className = "kata-bar-track";
      const fill = document.createElement("div");
      fill.className = `kata-bar-fill${score >= pass ? (score >= gold ? " gold" : " pass") : ""}`;
      fill.style.width = `${Math.min(100, (score / max) * 100)}%`;
      track.append(fill, barTick(pass, max, "pass"), barTick(gold, max, "gold"));
      scorecard.append(track);

      const line = document.createElement("div");
      line.className = "kata-bar-note";
      const saved =
        run.score !== undefined && run.score >= pass
          ? recordFinish(levelId, run.seed, run.score, run.score >= gold)
          : null;
      const progress = levelProgress(levelId);
      line.textContent = saved
        ? `pass ${pass} · gold ${gold} — saved best ${progress.best ?? run.score}${progress.gold ? " · gold" : ""}`
        : `pass ${pass} · gold ${gold} — below the pass bar, nothing saved`;
      scorecard.append(line);
    }

    scorecard.append(stepLine);
  }

  function setStatus(text: string, kind: "ok" | "bad" | "info"): void {
    status.textContent = text;
    status.className = `kata-status ${kind}`;
  }

  function setBusy(on: boolean): void {
    checkButton.disabled = on;
    runButton.disabled = on;
    stepButton.disabled = on;
  }

  return {
    destroy() {
      editor.destroy();
      timeline?.destroy();
      container.textContent = "";
    },
  };

  // --- helpers -----------------------------------------------------------------------
  function barTick(value: number, max: number, label: string): HTMLElement {
    const tick = document.createElement("div");
    tick.className = `kata-bar-tick ${label}`;
    tick.style.left = `${Math.min(100, (value / max) * 100)}%`;
    tick.textContent = label;
    return tick;
  }
}

/** Event boundaries for the Step control: every job start/end (deduped, sorted). */
function eventTimes(run: RunResult): number[] {
  const out = new Set<number>();
  for (const job of run.jobs) {
    if (typeof job.start === "number") out.add(job.start);
    if (typeof job.end === "number") out.add(job.end);
  }
  return [...out].sort((a, b) => a - b);
}

/** `check_kata` errors are objects; tolerate the legacy string form too. */
function normalizeErrors(errors: readonly (KataError | string)[]): KataError[] {
  return errors.map((error) =>
    typeof error === "string" ? { code: "kata", message: error } : error,
  );
}

function describe(error: unknown): string {
  const e = error as { code?: string; message?: string };
  return e && typeof e.code === "string" ? `${e.code}: ${e.message}` : String(error);
}

function toolButton(parent: HTMLElement, text: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kata-button";
  button.textContent = text;
  button.title = title;
  parent.append(button);
  return button;
}
