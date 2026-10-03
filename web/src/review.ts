/**
 * The review screen (Art 7, brief §2.6/§7): the calm post-run panel — "the strip is the post-run
 * review, because the top-down view loses the time axis". It opens at the end of a campus run
 * (live city, hand, endless) and is offered as a button for every other finished run (watch, kata,
 * phase-one hand) so *any* run can be reviewed without spamming a modal on page load.
 *
 * It decides nothing and calls nothing: everything is read from the finished run payload already
 * in hand (`run` / `step_result` / `hand_result` shapes — all `RunResult`). The strip is the SAME
 * timeline component as phase one (`render/timeline.ts`, mounted paused — idle cells are the dark
 * cells between bars); the fairness bars are `fairnessShares` (the only client-side fairness
 * arithmetic, `campus.ts`); mistakes are *derived* rows (timeouts, the overflow event, starved
 * shares), one calm line each, owner-colored on a swatch so hue never carries the sentence alone
 * ([[Concepts/Accessibility]] rule 8) and the copy names what to notice, never who to blame.
 */

import { fairnessShares } from "./campus";
import type { RunResult } from "./bridge";
import { trapDialog } from "./booth";
import { formatTime, mountTimeline, type TimelineHandle } from "./render/timeline";
import { readTokens } from "./tokens";

/** Endless extras for the best-score line (UI arithmetic from `run.end_time`, never a sim fact). */
export interface ReviewEndless {
  /** full literal sim-days survived (`floor(end_time / 86400)`, [[Concepts/Campus]]) */
  days: number;
  /** vehicles served (finished) this run */
  served: number;
  /** the persisted best before/including this run */
  bestDays: number;
  bestServed: number;
  isNewBest: boolean;
}

export interface ReviewOptions {
  /** overlay host; the panel overlay is `position: fixed`, so `document.body` is the normal choice */
  host?: HTMLElement;
  run: RunResult;
  title?: string;
  endless?: ReviewEndless;
  onClose?: () => void;
}

export interface ReviewHandle {
  close(): void;
}

/** One derived mistake row: whose vehicle (null = a run-wide fact) and the calm sentence. */
export interface MistakeRow {
  user: string | null;
  text: string;
}

/** The share math's view of a finished run (`FairnessJob` needs a numeric claimed length — a
 *  hidden-actual level still shows `est`, and `est ?? 0` matches what the vehicle drew). */
function shareJobs(run: RunResult) {
  return (run.jobs ?? []).map((j) => ({
    user: j.user, submit: j.submit, start: j.start, end: j.end, est: j.est ?? 0,
  }));
}

/** The mistakes a finished run tells, in a fixed order, aggregated per (user, kind) so the list
 *  stays one line per mistake *class* (an endless overflow strands hundreds of jobs — a thousand
 *  rows review nothing). All inputs are engine facts already in the payload. */
export function mistakesOf(run: RunResult): MistakeRow[] {
  const rows: MistakeRow[] = [];
  const end = run.end_time || 0;
  if (run.overflow) {
    rows.push({
      user: run.overflow,
      text: `${run.overflow}'s patience ring filled at ${formatTime(end)} — that is what ended `
        + `this run. Watch that neighbour's ring next time.`,
    });
  }
  const timedOut = new Map<string, number>();
  const neverParked = new Map<string, number>();
  const bump = (m: Map<string, number>, user: string): void => {
    m.set(user, (m.get(user) ?? 0) + 1);
  };
  for (const job of [...(run.jobs ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (job.submit > end) continue;                 // never reached the road — not a miss
    if (job.state === "timeout") bump(timedOut, job.user);
    else if (job.start === null || job.start === undefined) bump(neverParked, job.user);
  }
  for (const [user, n] of timedOut) {
    rows.push({
      user,
      text: `${n} vehicle${n === 1 ? "" : "s"} from ${user} waited on the road until their `
        + `patience timed out.`,
    });
  }
  for (const [user, n] of neverParked) {
    rows.push({
      user,
      text: `${n} vehicle${n === 1 ? "" : "s"} from ${user} waited until the run ended without `
        + `ever finding bays.`,
    });
  }
  // Starved shares — the same `fairnessShares` verdict the campus rail shows (§2.4), not a mood.
  for (const share of fairnessShares(shareJobs(run), end)) {
    if (!share.starved) continue;
    rows.push({
      user: share.user,
      text: `${share.user} was served under half the share it submitted `
        + `(${Math.round(share.servedShare * 100)}% of the campus's parked time vs the `
        + `${Math.round(share.askedShare * 100)}% it claimed).`,
    });
  }
  return rows;
}

/** Open the review panel (ONE at a time — opening another closes the previous, like offers). */
let current: ReviewHandle | null = null;

/** Close any open review panel (mode switches call it, so a panel never outlives its run view). */
export function closeReview(): void {
  current?.close();
}

export function openReviewPanel(opts: ReviewOptions): ReviewHandle {
  current?.close();
  const run = opts.run;
  const jobs = run.jobs ?? [];
  const end = run.end_time || 0;
  const overlay = document.createElement("div");
  overlay.className = "review-overlay";
  const panel = document.createElement("section");
  panel.className = "callout-panel review-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "review-title");
  overlay.append(panel);
  (opts.host ?? document.body).append(overlay);

  const title = document.createElement("h3");
  title.id = "review-title";
  title.textContent = `Run review — ${opts.title ?? String(run.level_id ?? "run")}`;
  const meta = document.createElement("p");
  meta.className = "review-meta hash";
  const served = jobs.filter((j) => j.state === "done").length;
  meta.textContent = `seed ${run.seed ?? "?"} · ${run.policy ?? "?"} · ${formatTime(end)} of traffic`
    + ` · ${served}/${jobs.length} vehicles served`;
  panel.append(title, meta);

  if (opts.endless) {
    const e = opts.endless;
    const line = document.createElement("p");
    line.className = "review-endless";
    line.setAttribute("role", "status");
    line.textContent = e.isNewBest
      ? `New best: ${e.days} days survived, ${e.served} vehicles served.`
      : `${e.days} days survived, ${e.served} served — beat your ${e.bestDays} days `
        + `(${e.bestServed} served).`;
    panel.append(line);
  }

  // --- the metrics the run settled on (engine facts, untouched) ------------------------------
  const m = run.metrics;
  const stats: [string, string][] = [
    ["utilization", `${(m.utilization * 100).toFixed(1)}%`],
    ["wait p95", formatTime(m.wait_p95)],
    ["bounded slowdown", m.bounded_slowdown.toFixed(2)],
    ["fairness", m.fairness.toFixed(3)],
  ];
  const statBox = document.createElement("div");
  statBox.className = "review-stats";
  for (const [label, value] of stats) {
    const stat = document.createElement("div");
    stat.className = "stat";
    const b = document.createElement("b");
    b.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;
    stat.append(b, span);
    statBox.append(stat);
  }
  panel.append(statBox);

  // --- the strip (idle cells = the dark cells between bars; phase-one machinery, paused) ------
  const stripHead = document.createElement("h4");
  stripHead.textContent = "The strip — bays over time (dark cells are idle)";
  const strip = document.createElement("div");
  strip.className = "review-strip";
  panel.append(stripHead, strip);
  let timeline: TimelineHandle | null = null;
  try {
    timeline = mountTimeline(strip, run, { autoplay: false, horizon: end || undefined });
  } catch { /* a strip that would not mount must not sink the review */ }

  // --- per-user share bars (rail machinery re-rendered from the finished job list) ------------
  const fair = document.createElement("section");
  fair.className = "campus-fairness";
  fair.setAttribute("aria-label", "Run fairness — served share versus submitted share");
  const fairHead = document.createElement("h3");
  fairHead.textContent = "Who was parked";
  const fairList = document.createElement("ul");
  fairList.className = "campus-fairness-list";
  fairList.setAttribute("role", "list");
  fair.append(fairHead, fairList);
  panel.append(fair);
  const tokens = readTokens();
  for (const r of fairnessShares(shareJobs(run), end)) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "fairness-who";
    const dot = document.createElement("i");
    dot.className = "fairness-dot";
    dot.style.background = tokens[`nb-${(r.index % 8) + 1}`] ?? "";
    const name = document.createElement("b");
    name.textContent = r.user;
    const mark = document.createElement("span");
    mark.className = "fairness-mark";
    mark.hidden = !r.starved;
    mark.textContent = r.starved ? "\u25c6 starved" : "";
    who.append(dot, name, mark);
    const bar = document.createElement("div");
    bar.className = "fairness-bar";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("i");
    fill.className = "fairness-served";
    fill.style.background = tokens[`nb-${(r.index % 8) + 1}`] ?? "";
    const tick = document.createElement("i");
    tick.className = "fairness-due";
    bar.append(fill, tick);
    const text = document.createElement("span");
    text.className = "fairness-text";
    const pct = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 100);
    text.textContent = `${pct(r.servedShare)}% served of ${pct(r.askedShare)}% submitted `
      + `· ${formatTime(r.servedSecs)} parked, ${formatTime(r.askedSecs)} claimed`
      + `${r.waiting > 0 ? ` · ${r.waiting} never parked` : ""}`;
    fill.style.width = `${pct(r.servedShare)}%`;
    tick.style.left = `${pct(r.askedShare)}%`;
    li.append(who, bar, text);
    fairList.append(li);
  }

  // --- the mistakes, one calm line each -------------------------------------------------------
  const misHead = document.createElement("h4");
  misHead.textContent = "What to notice next run";
  const misList = document.createElement("ul");
  misList.className = "review-mistakes";
  misList.setAttribute("role", "list");
  const rows = mistakesOf(run);
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "review-ok";
    p.textContent = "Nothing timed out, starved, or overflowed — a tidy run.";
    misList.append(p);
  }
  for (const row of rows) {
    const li = document.createElement("li");
    const dot = document.createElement("i");
    dot.className = "review-dot";
    if (row.user) dot.style.background = ownerColor(tokens, row.user, jobs);
    const text = document.createElement("span");
    text.textContent = row.text;
    li.append(dot, text);
    misList.append(li);
  }
  panel.append(misHead, misList);

  const actions = document.createElement("div");
  actions.className = "callout-actions";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Back to the campus";
  closeBtn.addEventListener("click", () => dismiss());
  actions.append(closeBtn);
  panel.append(actions);

  const previously = document.activeElement as HTMLElement | null;
  closeBtn.focus();
  trapDialog(panel, () => dismiss());
  let open = true;
  const handle: ReviewHandle = { close: () => dismiss() };
  function dismiss(): void {
    if (!open) return;
    open = false;
    timeline?.destroy();
    overlay.remove();
    if (current === handle) current = null;
    previously?.focus?.();
    opts.onClose?.();
  }
  current = handle;
  return handle;
}

/** Owner swatch color for a user — the same hash fallback `CampusPlay.ownerColor` uses when the
 *  user is not in the (already finished) scene. */
function ownerColor(tokens: Record<string, string>, user: string,
                    jobs: RunResult["jobs"]): string {
  const sorted = [...new Set(jobs.map((j) => j.user))].sort();
  let index = sorted.indexOf(user);
  if (index < 0) {
    let h = 0;
    for (let i = 0; i < user.length; i++) h = (h * 31 + user.charCodeAt(i)) | 0;
    index = Math.abs(h) % 8;
  }
  return tokens[`nb-${(index % 8) + 1}`] ?? "";
}

/** A "Review ▸" button for an already-finished run (the readout rows), so watch/kata/hand runs
 *  are reviewable too without a modal that fires the instant a page loads. */
export function mountReviewButton(host: HTMLElement, make: () => ReviewOptions): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "review-open";
  button.textContent = "Review \u25b8";
  button.addEventListener("click", () => openReviewPanel(make()));
  host.append(button);
}
