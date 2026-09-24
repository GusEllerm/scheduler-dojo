/**
 * localStorage persistence: `scheduler-dojo:v1` holds
 * `{ version, progress: {levelId: {best, gold, completed: [seeds played]}}, prefs }`.
 *
 * `save(patch)` deep-merges into the stored document (arrays merge as deduped unions, so
 * `completed` accumulates seeds), `load()` returns the migrated document. The version field has a
 * trivial migrate hook — a chain `migrations[n]` upgrading n -> n+1; v1 is current (identity).
 */

const KEY = "scheduler-dojo:v1";
const VERSION = 1;

export interface LevelProgress {
  best?: number;
  gold?: boolean;
  /** Seeds played (as strings; a run "completes" the level once per seed). */
  completed?: string[];
}

export interface Prefs {
  mode?: "watch" | "hand";
  level?: string;
  [extra: string]: unknown;
}

export interface Store {
  version: number;
  progress: Record<string, LevelProgress>;
  prefs: Prefs;
}

/** A partial document accepted by `save()` — same shape, everything optional. */
export type StorePatch = DeepPartial<Omit<Store, "version">> & { version?: number };

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const EMPTY: Store = { version: VERSION, progress: {}, prefs: {} };

/** Upgrade chain: `migrations[n]` turns a version-n document into version n+1. v1 is the base. */
const migrations: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {};

export function load(): Store {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { ...EMPTY }; // private mode / blocked storage: run in-memory
  }
  if (!raw) return { ...EMPTY };
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { ...EMPTY };
    doc = parsed as Record<string, unknown>;
  } catch {
    return { ...EMPTY };
  }
  let version = typeof doc.version === "number" ? doc.version : 1;
  while (version < VERSION) {
    const step = migrations[version];
    if (!step) break; // no path forward: keep the doc as-is rather than lose it
    doc = step(doc);
    version += 1;
    doc.version = version;
  }
  return normalize(doc);
}

/** Deep-merge `patch` into the stored document and write it back; returns the new document. */
export function save(patch: StorePatch): Store {
  const merged = normalize(merge(load() as unknown as Record<string, unknown>, patch));
  merged.version = VERSION;
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    /* quota / blocked storage: keep the in-memory view for this session */
  }
  return merged;
}

/** Record a finished hand run: best score (max), gold flag, and the seed in `completed`. */
export function recordFinish(
  levelId: string,
  seed: number,
  score: number | undefined,
  gold = false,
): Store {
  const prev = load().progress[levelId] ?? {};
  const patch: StorePatch = {
    progress: {
      [levelId]: {
        ...(score !== undefined ? { best: Math.max(prev.best ?? 0, score) } : {}),
        ...(gold || prev.gold ? { gold: true } : {}),
        completed: [String(seed)],
      },
    },
  };
  return save(patch);
}

export function levelProgress(levelId: string): LevelProgress {
  return load().progress[levelId] ?? {};
}

// --- helpers -------------------------------------------------------------------------

function normalize(doc: Record<string, unknown>): Store {
  const progress = doc.progress;
  const prefs = doc.prefs;
  return {
    version: typeof doc.version === "number" ? doc.version : VERSION,
    progress: typeof progress === "object" && progress !== null ? (progress as Record<string, LevelProgress>) : {},
    prefs: typeof prefs === "object" && prefs !== null ? (prefs as Prefs) : {},
  };
}

/** Plain-object deep merge; arrays become deduped unions (so `completed` accumulates). */
function merge(target: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  if (!isPlain(patch)) return target;
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const before = out[key];
    if (Array.isArray(before) && Array.isArray(value)) {
      out[key] = Array.from(new Set([...before, ...value]));
    } else if (isPlain(before) && isPlain(value)) {
      out[key] = merge(before, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
