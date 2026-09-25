/**
 * The single source of truth for the WASM runtime + wheel coordinates.
 *
 * Everything (worker, smoke test, dev server) reads the pins from here — see
 * web/README-dev-notes.md for why 0.29.x is the line we pin (stable CPython 3.12).
 */

/** Pyodide runtime version — the ONE place it is pinned. */
export const PYODIDE_VERSION = "0.29.5";

/** CDN directory for the runtime (used by the browser worker). */
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** ESM entry point of the runtime (dynamically imported by the worker). */
export const PYODIDE_ESM_URL = `${PYODIDE_INDEX_URL}pyodide.mjs`;

/** Versioned wheel name staged by scripts/build_wheel.sh into web/public/wheels/. */
export const WHEEL_NAME = "scheduler_dojo-0.1.0-py3-none-any.whl";

/**
 * Subpath-relative path from the worker's own URL to the wheel.
 * - Built bundle lives at `<base>assets/worker-*.js` → the wheel is `../wheels/<name>`.
 * - Dev serves the worker at `/src/worker.ts` → the wheel is `../../wheels/<name>` (public root).
 * A GitHub-Pages project site is served under a subpath (`/scheduler-dojo/`); deriving the wheel URL
 * from `import.meta.url` (not `location.origin`) is what makes the install work there too.
 */
export function wheelUrlFor(workerMetaUrl: string, name: string = WHEEL_NAME): string {
  const up = workerMetaUrl.includes("/src/") ? "../../" : "../";
  return new URL(`${up}wheels/${name}`, workerMetaUrl).href;
}
