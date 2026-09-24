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
}

export interface JobInfo {
  id: string;
  user: string;
  nodes: number;
  submit: number;
  start: number | null;
  end: number | null;
  runtime: number;
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
  errors: string[];
}

/** A level document (the JSON in levels/*.json); kept loose — Python validates it. */
export type Level = Record<string, unknown> & { id?: string; seed?: number };

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

  /** Start an interactive run; returns a handle for step_n / step_until. */
  startRun(level: Level | string, options: RunOptions = {}): Promise<{ handle: number; state: StepState }> {
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

  stepResult(handle: number): Promise<Pick<RunResult, "metrics" | "trajectory_hash" | "jobs" | "end_time">> {
    return this.call("step_result", { handle });
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

export interface StepState {
  now: number;
  events_processed: number;
  queued: string[];
  running: { id: string; nodes: string[]; start: number | null }[];
  finished: number;
  done: boolean;
}

/** Convenience default instance (a page holds exactly one worker). */
export const bridge = new DojoBridge();
