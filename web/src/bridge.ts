/**
 * Typed client for the Pyodide worker. One worker per page, a monotonic request id, and a
 * promise per in-flight call. The wire protocol is defined by `scheduler_dojo.bridge.dispatch`
 * in Python: `{id, call, args}` -> `{id, result}` or `{id, error: {code, message}}`.
 */

import type { WorkerEvent } from "./worker";

// --- payload types (mirror bridge.run's JSON contract) --------------------------------

export type JobState = "done" | "timeout" | "unfinished";

export interface NodeInfo {
  id: string;
  name: string;
  cpus: number;
  gpus: number;
  partition: string;
  site?: string;
}

export interface JobInfo {
  id: string;
  user: string;
  nodes: number;
  submit: number;
  start: number | null;
  end: number | null;
  runtime?: number;  // absent when the level hides actuals (sensor rule)
  /** claimed walltime — always visible (vehicle length) */
  est?: number;
  /** real node ids this job ran on */
  placed?: string[];
  site?: string;
  home?: string;
  state: JobState;
}

export interface Metrics {
  utilization: number;
  bounded_slowdown: number;
  wait_p95: number;
  fairness: number;
  sla?: number;
}

export interface RunResult {
  level_id?: string;
  seed: number;
  policy: string;
  nodes: NodeInfo[];
  jobs: JobInfo[];
  end_time: number;
  n_jobs: number;
  node_seconds_busy: number;
  node_seconds_total: number;
  metrics: Metrics;
  trajectory_hash: string;
  score?: number;
  bars?: { pass_score?: number; gold_score?: number };
}

export interface KataReport {
  ok: boolean;
  /** `check_kata` returns `{code, message, line (1-based), col}` dicts. */
  errors: KataError[];
}

/** One `check_kata` error — `line` is 1-based (see kata/check.py). */
export interface KataError {
  code: string;
  message: string;
  line?: number;
  col?: number;
}

/** Format a `check_kata` error list for a one-line message (used by watch mode). */
export function formatKataErrors(errors: readonly (KataError | string)[]): string {
  return errors
    .map((error) =>
      typeof error === "string" ? error : `${error.line ?? "?"}: ${error.code} — ${error.message}`,
    )
    .join("; ");
}

// --- progression (Stage 7; bridge.py progression_*) -------------------------------------

/** The persisted progression state (see `scheduler_dojo.progression`); the client owns storage. */
export interface ProgressionState {
  version: number;
  credits: number;
  lifetime: number;
  levels: Record<string, { best: number; gold: boolean; passes: number[] }>;
  upgrades: string[];
  last_seen: number;
  /** Transient per-call extras the engine attaches (awards); not part of the saved contract. */
  _last_award?: number;
  _drift_award?: number;
}

export interface UpgradeInfo {
  cost: number;
  requires: string[];
  unlocks: string[];
  owned: boolean;
  buyable: boolean;
}

/** What `progression_view` returns — a read-only HUD snapshot. */
export interface ProgressionView {
  belt: string;
  next_belt: [string, number] | null;
  credits: number;
  lifetime: number;
  unlocked: string[];
  upgrades: Record<string, UpgradeInfo>;
}

/** A level document (the JSON in levels/*.json); kept loose — Python validates it. */
export type Level = Record<string, unknown> & { id?: string; seed?: number };

// --- share cards (Stage 9; bridge.py share_*) ----------------------------------------

/** Arguments of `share_encode`. Pass the inline `level` dict for a shipped/sandbox card. */
export interface ShareEncodeArgs {
  level?: Level | null;
  seed?: number | null;
  policy?: string;
  kata?: string | null;
  levelId?: string | null;
}

/** What `share_encode` returns: the `#c=…` payload plus the embedded result hash. */
export interface ShareMint {
  payload: string;
  hash: string;
}

/** What `share_replay` returns: a re-run of the card and the hash comparison. */
export interface ShareReplayResult {
  ok: boolean;
  metrics: Metrics;
  trajectory_hash: string;
  expected_hash: string | null;
  score?: number;
}

export interface RunOptions {
  seed?: number | null;
  policy?: string;
  /** Kata source text (or a path readable by the sim). */
  kata?: string | null;
}

/** A structured failure reported by the Python boundary (or the worker itself). */
export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

// --- client --------------------------------------------------------------------------

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

export class DojoBridge {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(event: WorkerEvent) => void>();

  constructor(worker?: Worker) {
    this.worker =
      worker ??
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent) => this.receive(event.data);
    this.worker.onerror = (event) => {
      const error = new BridgeError("worker", event.message || "worker crashed");
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
  }

  /** Subscribe to loading progress / status events; returns an unsubscribe function. */
  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Call a bridge function by name. `args` is kwargs (object) or positional (array). */
  call<T>(name: string, args?: Record<string, unknown> | unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, call: name, args });
    });
  }

  ping(): Promise<{ ok: boolean; version: string }> {
    return this.call("ping");
  }

  version(): Promise<{ version: string; python_ok: boolean }> {
    return this.call("version");
  }

  runLevel(level: Level | string, options: RunOptions = {}): Promise<RunResult> {
    const args: Record<string, unknown> = { level, policy: options.policy ?? "fifo" };
    if (options.seed !== undefined && options.seed !== null) args.seed = options.seed;
    if (options.kata !== undefined && options.kata !== null) args.kata = options.kata;
    return this.call<RunResult>("run", args);
  }

  checkKata(kata: string): Promise<KataReport> {
    return this.call<KataReport>("check_kata", { kata });
  }

  /**
   * Run a level under a kata source string (`bridge.run` with `kata` set — the policy label
   * becomes "kata"). Sugar over `runLevel(level, { policy: "kata", kata })`.
   */
  runKata(level: Level | string, kata: string, options: { seed?: number | null } = {}): Promise<RunResult> {
    return this.runLevel(level, { policy: "kata", kata, seed: options.seed ?? null });
  }

  /** Start an interactive run; returns a handle for step_n / step_until. */
  startRun(level: Level | string, options: RunOptions = {}): Promise<{ handle: number; state: StepState; nodes?: NodeInfo[] }> {
    const args: Record<string, unknown> = { level, policy: options.policy ?? "fifo" };
    if (options.seed !== undefined && options.seed !== null) args.seed = options.seed;
    if (options.kata !== undefined && options.kata !== null) args.kata = options.kata;
    return this.call("start", args);
  }

  stepUntil(handle: number, t: number): Promise<{ state: StepState; done: boolean }> {
    return this.call("step_until", { handle, t });
  }

  stepN(handle: number, n = 1): Promise<{ state: StepState; done: boolean }> {
    return this.call("step_n", { handle, n });
  }

  stepResult(handle: number): Promise<Partial<RunResult> & { metrics: Metrics; trajectory_hash: string; jobs: JobInfo[]; end_time: number }> {
    return this.call("step_result", { handle });
  }

  /** Renderer pacing facts (sim-step between snapshots, sun stride) — engine-owned (§5.6). */
  watchPlan(level: Level | string): Promise<WatchPlan> {
    return this.call("watch_plan", { level });
  }

  /** Day/week/sun position of a sim time, computed by the engine. */
  calendarAt(t: number, level: Level | string): Promise<{ day: number; week: number; sun: number; week_end: number }> {
    return this.call("calendar_at", { t, level });
  }

  // --- hand placement (Stage 5; bridge.py hand_*) -------------------------------------

  /** Start a manual run: nothing auto-places; the player drives `handPlace` / `handTick`. */
  handStart(level: Level | string, seed?: number | null): Promise<HandStartResult> {
    const args: Record<string, unknown> = { level };
    if (seed !== undefined && seed !== null) args.seed = seed;
    return this.call<HandStartResult>("hand_start", args);
  }

  /** Place one queued job by hand; the engine validates and answers `{ok, state, error?}`. */
  handPlace(handle: number, jobId: string, nodes?: string[] | null): Promise<HandPlaceResult> {
    const args: Record<string, unknown> = { handle, job_id: jobId };
    if (nodes !== undefined && nodes !== null) args.nodes = nodes;
    return this.call<HandPlaceResult>("hand_place", args);
  }

  /** Advance the manual clock to the next arrival/finish event (or to absolute `until`). */
  handTick(handle: number, until?: number | null): Promise<HandTickResult> {
    const args: Record<string, unknown> = { handle };
    if (until !== undefined && until !== null) args.until = until;
    return this.call<HandTickResult>("hand_tick", args);
  }

  /** Finish the manual run: metrics + jobs + hash (identical determinism to any run). */
  handResult(handle: number): Promise<HandResultPayload> {
    return this.call<HandResultPayload>("hand_result", { handle });
  }

  // --- progression (Stage 7; bridge.py progression_*) ------------------------------------

  /** Read-only HUD snapshot. `state` null ⇒ the engine migrates a fresh one for the view. */
  progressionView(state: ProgressionState | null, now = 0): Promise<ProgressionView> {
    return this.call<ProgressionView>("progression_view", { state, now });
  }

  /** Record a finished level run; returns the NEW state (credits awarded) to persist. */
  progressionCompletion(state: ProgressionState | null, levelId: string, score: number, seed: number): Promise<ProgressionState> {
    return this.call<ProgressionState>("progression_completion", {
      state, level_id: levelId, score, seed,
    });
  }

  /** Buy an upgrade; the engine raises unless `buyable` — check the view first. */
  progressionBuy(state: ProgressionState | null, upgradeId: string): Promise<ProgressionState> {
    return this.call<ProgressionState>("progression_buy", { state, upgrade_id: upgradeId });
  }

  /** Offline welcome-back credits since `last_seen` (capped); returns the NEW state. */
  progressionDrift(state: ProgressionState | null, now: number): Promise<ProgressionState> {
    return this.call<ProgressionState>("progression_drift", { state, now });
  }

  // --- share cards (Stage 9; bridge.py share_*) ----------------------------------------

  /** Run + mint a replayable `#c=` card (the engine embeds the run's trajectory hash). */
  shareEncode(args: ShareEncodeArgs): Promise<ShareMint> {
    return this.call<ShareMint>("share_encode", {
      level: args.level ?? null,
      seed: args.seed ?? null,
      policy: args.policy ?? "fifo",
      kata: args.kata ?? null,
      level_id: args.levelId ?? null,
    });
  }

  /** Re-run a card payload and check its hash. `level` is needed for cards that only reference a
   *  level_id — and for shipped levels with an explicit `jobs` list, whose job data the card
   *  itself does not embed (the engine's card schema carries generator/cluster only). */
  shareReplay(payload: string, level?: Level | null): Promise<ShareReplayResult> {
    return this.call<ShareReplayResult>("share_replay", { payload, level: level ?? null });
  }

  /** Tear the worker down (page teardown / tests). */
  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
    this.listeners.clear();
  }

  private receive(message: { id?: number } & Record<string, unknown>): void {
    if (!message || typeof message.id !== "number") {
      this.emit(message as unknown as WorkerEvent);
      return;
    }
    const slot = this.pending.get(message.id);
    if (!slot) return;
    this.pending.delete(message.id);
    if ("error" in message && message.error) {
      const error = message.error as { code?: string; message?: string };
      slot.reject(new BridgeError(error.code ?? "bridge", error.message ?? "bridge call failed"));
      return;
    }
    slot.resolve(message.result);
  }

  private emit(event: WorkerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** What `hand_start` / `hand_tick` suggest: job id -> node ids FIFO *would* use (hint only). */
export type HandSuggestions = Record<string, string[]>;

export interface HandStartResult {
  handle: number;
  state: StepState;
  suggestions: HandSuggestions;
  nodes: NodeInfo[];
}

/** `hand_place` never rejects for a rules violation — it answers `{ok:false, error}` instead. */
export interface HandPlaceResult {
  ok: boolean;
  state: StepState;
  error?: { code: string; message: string };
}

export interface HandTickResult {
  state: StepState;
  suggestions?: HandSuggestions;
  done: boolean;
}

export interface HandResultPayload {
  metrics: Metrics;
  jobs: JobInfo[];
  end_time: number;
  trajectory_hash: string;
  score?: number;
}

export interface StepState {
  now: number;
  events_processed: number;
  queued: string[];
  running: { id: string; nodes: string[]; start: number | null; end?: number }[];
  /** reserve() intents (job id -> intended start) — cones on the campus */
  reserved?: Record<string, number>;
  /** per-user patience rings (0..1); present on levels with `pressure` */
  pressure?: Record<string, number>;
  /** user whose ring overflowed ('' when none) */
  overflow?: string;
  finished: number;
  done: boolean;
}

export interface WatchPlan {
  step: number;
  tick: number | null;
  stride: number;
  duration: number;
}

/** Convenience default instance (a page holds exactly one worker). */
export const bridge = new DojoBridge();
