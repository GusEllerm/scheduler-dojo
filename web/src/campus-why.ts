/**
 * campus-why.ts — the booth's *why* lines (Art 5b): decision-trace records rendered as calm,
 * plain sentences for the campus why-panel and the hand-mode misfit reason.
 *
 * The records are the engine's (`Scheduler._trace_event` + the `KataPolicy` tracer, surfaced by
 * `start(trace=N)` on every `step_n`/`step_until` result — Concepts/Campus.md). Nothing here
 * decides anything and nothing is invented: a line only states what the record says. The one
 * *inference* is naming an order key by its metric ("shortest first"): the record carries the
 * computed key per queued job, so the key's first component is compared to that vehicle's OWN
 * engine facts (claimed length, submit time, bay count) and the first metric that explains every
 * entry wins. If none does, the line says so instead of guessing.
 */

import type { TraceRecord } from "./bridge";

/** What the viewer knows about a vehicle (all engine-supplied: `est`, `submit`, `nodes`, `user`). */
export interface JobFacts {
  user: string;
  est: number;
  submit: number;
  nodes: number;
}

/** One rendered row: `seq` is the engine's monotonic trace id (the de-duplication key). */
export interface WhyRow {
  seq: number;
  /** sim time of the decision (never wall clock) */
  t: number;
  /** the owner whose color the row wears, null when no vehicle is involved (a fallback) */
  user: string | null;
  text: string;
}

/** The empty-state sentence (what the panel WILL show once the booth starts deciding). */
export const WHY_EMPTY = "Nothing decided yet — as soon as the booth chooses, each decision lands "
  + "here: which vehicle it picked, the order it ranked the road by, the gap it parked it in, and "
  "any fallback with its reason.";

/** Order-key metrics, in the order they are tried (first one that fits every entry wins). */
const METRICS: readonly [string, (k: number, f: JobFacts) => boolean][] = [
  ["shortest first", (k, f) => k === f.est && f.est > 0],
  ["longest first", (k, f) => k === 0 - f.est && f.est > 0],
  ["biggest first", (k, f) => k === 0 - f.nodes && f.nodes > 0],
  ["smallest first", (k, f) => k === f.nodes && f.nodes > 0],
  ["oldest first", (k, f) => k === f.submit],
  ["newest first", (k, f) => k === 0 - f.submit],
];

/** Name the metric an `order` record ranked the road by, from its computed keys. */
export function orderPhrase(
  keys: readonly [string, unknown[]][],
  factsOf: (id: string) => JobFacts | null,
): string {
  const seen = keys.map(([id, key]) => ({ k: Array.isArray(key) ? key[0] : key, f: factsOf(id) }));
  if (!seen.length) return "the road is empty";
  for (const [phrase, matches] of METRICS) {
    if (seen.every((e) => typeof e.k === "number" && e.f && matches(e.k, e.f))) return phrase;
  }
  return "an order key of its own";
}

/** A fallback record's sentence: the engine's code is always visible, never paraphrased away. */
export function fallbackPhrase(code: string): string {
  const c = code.toLowerCase();
  const plain: Record<string, string> = {
    no_nodes: "no fit — kept FIFO order",
    mismatch: "the cards asked for bays that lot cannot give — kept FIFO order",
    step_budget: "the cards ran out of steps — kept FIFO order",
    slot_locked: "that rule is not unlocked yet — kept FIFO order",
    sensor_locked: "a guess was used before sensors — kept FIFO order",
    internal: "the cards tripped the engine — kept FIFO order",
  };
  // An unmapped code still says what the engine said (it is the engine's own word for the failure).
  return plain[c] ? `${plain[c]} (${c})` : `the cards stopped at "${c}" — kept FIFO order`;
}

/** Render the last-N records as rows, oldest first (the panel is a log you read downward). */
export function whyRows(
  records: readonly TraceRecord[],
  factsOf: (id: string) => JobFacts | null,
): WhyRow[] {
  const out: WhyRow[] = [];
  let phrase = "";
  for (const rec of records) {
    const seq = rec.seq ?? 0;
    const user = rec.job ? factsOf(rec.job)?.user ?? null : null;
    switch (rec.action) {
      case "order": {
        phrase = orderPhrase(rec.keys ?? [], factsOf);
        out.push({
          seq, t: rec.t, user: rec.job ? user : null,
          text: rec.job ? `${rec.job} leads the road — ${phrase}` : `ranked the road — ${phrase}`,
        });
        break;
      }
      case "place": {
        const bays = (rec.nodes ?? []).slice(0, 6).join(" ")
          + ((rec.nodes?.length ?? 0) > 6 ? " …" : "");
        const move = (rec.transfer ?? 0) > 0 ? ` · +${fmt(rec.transfer ?? 0)} transfer` : "";
        out.push({
          seq, t: rec.t, user,
          text: `${rec.job} parked on ${bays || "—"}${move}${phrase ? ` — ${phrase}` : ""}`,
        });
        break;
      }
      case "preempt":
        out.push({
          seq, t: rec.t, user,
          text: `${rec.job} pulled off ${(rec.nodes ?? []).join(" ")} — the work it had done is gone`,
        });
        break;
      case "route":
        out.push({
          seq, t: rec.t, user,
          text: `${rec.job} routed to ${rec.site ?? "another campus"}`
            + ((rec.transfer ?? 0) > 0 ? ` · +${fmt(rec.transfer ?? 0)} transfer` : ""),
        });
        break;
      case "fallback":
        out.push({ seq, t: rec.t, user: null, text: fallbackPhrase(rec.code ?? "") });
        break;
      default:
        out.push({ seq, t: rec.t, user, text: `${rec.action} ${rec.job}`.trim() });
    }
  }
  return out;
}

/**
 * A hand-placement refusal in campus words (`hand_place` answers with a `PolicyError` code —
 * `scheduler_dojo.sim.errors`: `no_nodes`, `mismatch`, `already_running`, `deps_unmet`,
 * `unknown_job`). The raw code stays on the end: the engine said it, we do not paraphrase it away.
 */
export function misfitReason(code: string, message: string): string {
  const c = code.toLowerCase();
  const plain: Record<string, string> = {
    no_nodes: "not enough bays are free together for the whole window — the road must wait, or "
      + "this vehicle can take fewer bays",
    mismatch: "wrong bays for this vehicle — wrong lot, wrong count, or a bay that cannot hold it",
    already_running: "that vehicle is already parked",
    deps_unmet: "its convoy has not finished yet — it cannot park until they have",
    unknown_job: "that vehicle is not on the road any more",
  };
  return `${plain[c] ?? message} (${c})`;
}

function fmt(t: number): string {
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m`;
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}
