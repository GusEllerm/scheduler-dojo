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

/** vite's deploy base ("/" by default). */
const BASE_URL: string =
  ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL) ?? "/";

/**
 * Absolute wheel URL derived from the *worker's own* location (origin) plus vite's `base` —
 * `public/` is served at that root in dev (`/src/worker.ts`) and in a build
 * (`/assets/worker-<hash>.js`), so this is correct for either layout and cwd-independent.
 */
export const WHEEL_URL = new URL(`${BASE_URL}wheels/${WHEEL_NAME}`, originOf()).href;

/** Base directory holding the wheel (what micropip installs from). */
export const WHEELS_BASE = WHEEL_URL.slice(0, WHEEL_URL.lastIndexOf("/") + 1);

function originOf(): string {
  const href = (self as { location?: Location } | undefined)?.location?.href;
  if (!href) return "http://localhost/";
  const url = new URL(href);
  return `${url.protocol}//${url.host}/`;
}
