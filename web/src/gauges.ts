/**
 * Live gauges for hand play: a utilization bar and a queue-length bar, computed client-side from
 * the successive `StepState` snapshots the hand controller feeds in. This is an *estimate* — the
 * authoritative numbers come from `hand_result` at Finish.
 *
 * Utilization math (kept simple and monotone): we keep a per-job tally of running placements
 * (job id -> {node count, start}). Whenever a snapshot arrives at time `now`, every job that
 * occupied nodes during the interval (prevNow, now] — including one that finished exactly at
 * `now` and so already vanished from `state.running` — contributes `nodes * (now - max(start,
 * prevNow))` to a running busy-node-seconds total. Utilization is that total over
 * `node_count * (now - t0)`, where t0 is the first observed clock time; the displayed value is
 * clamped to [0, 1] and never decreases (a monotone max over updates).
 *
 * Queue length is just `state.queued.length`, drawn against the largest queue seen so far.
 */

import { formatTime } from "./render/timeline";
import type { StepState } from "./bridge";

export interface GaugesHandle {
  /** Feed the latest snapshot; recomputes and repaints both gauges. */
  update(state: StepState): void;
  destroy(): void;
}

interface Tracked {
  nodes: number;
  start: number;
}

export function mountGauges(container: HTMLElement): GaugesHandle {
  container.classList.add("dojo-gauges");
  container.textContent = "";

  const util = bar(container, "utilization (live est.)");
  const queue = bar(container, "queue length");
  const meta = document.createElement("div");
  meta.className = "dojo-gauge-meta";
  container.append(meta);

  const tracked = new Map<string, Tracked>();
  let prevNow = 0;
  let t0: number | null = null;
  let busyNodeSeconds = 0;
  let utilShown = 0;
  let queuePeak = 1;
  let seen = false;

  function update(state: StepState): void {
    const now = state.now;
    if (!seen) {
      t0 = now;
      prevNow = now;
      seen = true;
    }
    if (now > prevNow) {
      const current = new Map(state.running.map((job) => [job.id, job]));
      // Jobs still running (or started earlier and gone by now — a finish lands on `now`)
      // each occupied their nodes across (prevNow, now] from whenever they started.
      for (const [id, job] of current) {
        const start = Math.max(job.start ?? prevNow, prevNow);
        busyNodeSeconds += job.nodes.length * (now - start);
        tracked.set(id, { nodes: job.nodes.length, start: job.start ?? prevNow });
      }
      for (const [id, info] of tracked) {
        if (current.has(id)) continue;
        // Not in `running` anymore: it ended at (or before) this event time — credit the tail.
        busyNodeSeconds += info.nodes * (now - Math.max(info.start, prevNow));
        tracked.delete(id);
      }
      prevNow = now;
    }

    const span = Math.max(1, now - (t0 ?? 0));
    const utilValue = Math.min(1, busyNodeSeconds / span);
    utilShown = Math.max(utilShown, utilValue); // monotone display
    const runningSlots = state.running.reduce((sum, job) => sum + job.nodes.length, 0);
    util.setValue(utilShown, `${(utilShown * 100).toFixed(1)}% · ${runningSlots} busy now`);

    const qlen = state.queued.length;
    queuePeak = Math.max(queuePeak, qlen);
    queue.setValue(qlen / queuePeak, `${qlen} queued (peak ${queuePeak})`, qlen / queuePeak === 0);

    meta.textContent = `t = ${formatTime(now)} · finished ${state.finished}`;
  }

  return {
    update,
    destroy() {
      container.textContent = "";
      container.classList.remove("dojo-gauges");
    },
  };
}

interface BarHandle {
  /** fraction in [0,1]; label text shown next to the value. */
  setValue(fraction: number, label: string, emptyIsFull?: boolean): void;
}

function bar(container: HTMLElement, title: string): BarHandle {
  const wrap = document.createElement("div");
  wrap.className = "dojo-gauge";
  const head = document.createElement("div");
  head.className = "dojo-gauge-head";
  const name = document.createElement("span");
  name.textContent = title;
  const value = document.createElement("b");
  head.append(name, value);
  const track = document.createElement("div");
  track.className = "dojo-gauge-track";
  const fill = document.createElement("div");
  fill.className = "dojo-gauge-fill";
  track.append(fill);
  wrap.append(head, track);
  container.append(wrap);
  return {
    setValue(fraction, label, empty = false) {
      const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      fill.style.width = `${empty ? 0 : Math.max(pct, 2)}%`;
      fill.classList.toggle("low", pct < 30);
      value.textContent = label;
    },
  };
}
