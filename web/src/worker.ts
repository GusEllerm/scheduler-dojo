/**
 * The Pyodide worker: owns the WASM runtime and the `scheduler_dojo.bridge` module, and is the
 * only place that touches Python. Page <-> worker protocol (see bridge.py + README-dev-notes):
 *
 *   in      { id, call, args }                    args = kwargs object | positional array
 *   out     { id, result } | { id, error: {code, message} }
 *   events  { type: "status" | "progress" | "ready" | "error", ... }
 *
 * All engine logic stays in Python: we call `bridge.dispatch(call, args)`, which already turns
 * exceptions into `{error}` — a JS-side throw here is a *worker* bug and is reported as such.
 */

import type { PyodideInterface } from "pyodide";
import { PYODIDE_ESM_URL, PYODIDE_INDEX_URL, PYODIDE_VERSION, WHEEL_NAME, wheelUrlFor } from "./version";

/** Anything the loading screen can act on. */
export type WorkerEvent =
  | { type: "status"; stage: Stage; detail: string }
  | { type: "progress"; stage: Stage; loaded: number; total: number | null; pct: number | null }
  | { type: "ready"; pyodide: string; version?: string }
  | { type: "error"; message: string };

export type Stage = "runtime" | "packages" | "wheel" | "bridge";

type Request = { id: number; call: string; args?: unknown };
type BridgeModule = { dispatch: (call: string, args: unknown) => unknown; version: () => unknown };
type Dumps = { apply(that: null, args: unknown[]): string; destroy?: () => void };

let dumps: Dumps | null = null;

type WorkerScope = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
};

const ctx = self as unknown as WorkerScope;
let pyodide: PyodideInterface | null = null;
let bridge: BridgeModule | null = null;
let booted: Promise<void> | null = null;
let nativeFetch: typeof fetch | null = null;

function send(message: Record<string, unknown>): void {
  ctx.postMessage(message);
}

function status(stage: Stage, detail: string): void {
  send({ type: "status", stage, detail });
}

function progress(stage: Stage, loaded: number, total: number | null): void {
  const pct = total && total > 0 ? Math.min(1, loaded / total) : null;
  send({ type: "progress", stage, loaded, total, pct });
}

// --- download progress -------------------------------------------------------------
// Pyodide (and micropip) fetch their bytes through `fetch`, so wrapping it once gives honest
// byte-level progress for the loading screen. The response is rebuilt around a counting stream,
// with `url`/`type`/`ok` re-pinned as own properties because micropip parses the wheel name off
// `response.url` and the `Response` constructor cannot carry them over.
function instrumentFetch(): void {
  if (nativeFetch) return;
  nativeFetch = globalThis.fetch.bind(globalThis) as typeof fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch!(input as RequestInfo, init);
    const url = response.url || String(typeof input === "string" ? input : (input as URL)?.href ?? "");
    const stage: Stage = url.includes("/wheels/") ? "wheel" : "runtime";
    return countBytes(response, stage);
  }) as typeof fetch;
}

function uninstrumentFetch(): void {
  if (nativeFetch) {
    globalThis.fetch = nativeFetch;
    nativeFetch = null;
  }
}

function countBytes(response: Response, stage: Stage): Response {
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;
  progress(stage, 0, total);
  if (!response.body) return response;
  const reader = response.body.getReader();
  let loaded = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      loaded += chunk.value.byteLength;
      progress(stage, loaded, total);
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const key of ["url", "type", "redirected", "ok"] as const) {
    try {
      Object.defineProperty(wrapped, key, { value: response[key], configurable: true });
    } catch {
      /* read-only in this engine; micropip still has the request URL */
    }
  }
  return wrapped;
}

// --- boot ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  status("runtime", `loading Pyodide ${PYODIDE_VERSION}`);
  instrumentFetch();
  const loadPyodide = (await import(/* @vite-ignore */ PYODIDE_ESM_URL) as {
    loadPyodide: (options: { indexURL: string }) => Promise<PyodideInterface>;
  }).loadPyodide;
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  const py = pyodide;

  status("packages", "loading micropip");
  await py.loadPackage("micropip");

  status("wheel", `installing ${WHEEL_NAME}`);
  let wheelUrl = wheelUrlFor(import.meta.url, WHEEL_NAME);
  if (import.meta.hot) {
    // Dev only: Pyodide caches installed packages by URL, so a rebuilt-but-same-named wheel would
    // never refresh. A per-boot cache-buster keeps the dev wheel honest (prod URLs stay stable).
    wheelUrl += (wheelUrl.includes("?") ? "&" : "?") + "v=" + Date.now();
  }
  await py.runPythonAsync(`import micropip\nawait micropip.install(${JSON.stringify(wheelUrl)})`);
  uninstrumentFetch();

  status("bridge", "importing scheduler_dojo.bridge");
  await py.runPythonAsync("from scheduler_dojo import bridge as __bridge");
  const mod = py.globals.get("__bridge") as unknown as BridgeModule;
  bridge = mod;

  const info = (jsify(mod.version()) ?? {}) as { version?: string };
  send({ type: "ready", pyodide: PYODIDE_VERSION, version: info.version });
}

// --- value marshalling ---------------------------------------------------------------
// JS -> Python: `pyodide.toPy` recursively turns plain objects into dicts and arrays into
// lists, which is exactly the `dict | list` shape `dispatch` expects (a bare `args.toJs` would
// be wrong here: our args originate in JS).
// Python -> JS: `toJs` with `dict_converter: Object.fromEntries` gives plain objects (the
// default is `Map`, which structured-clone would hand the page as unusable Maps) and
// `create_pyproxies: false` so a non-JSON-safe value throws instead of smuggling a proxy into
// postMessage. The JSON round-trip is the fallback for anything exotic.
function toPyArgs(args: unknown): unknown {
  if (args === undefined || args === null) return null;
  return pyodide!.toPy(args);
}

function jsify(value: unknown): unknown {
  const proxy = value as { toJs?: (options: unknown) => unknown; destroy?: () => void };
  if (proxy && typeof proxy.toJs === "function") {
    try {
      return proxy.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
    } catch {
      // Fallback for anything `toJs` refuses: the bridge contract is JSON-safe, so let Python
      // serialise it and parse the text.
      dumps ??= pyodide!.runPython("import json\n(lambda o: json.dumps(o))") as Dumps;
      const text = dumps!.apply(null, [value]) as string;
      return JSON.parse(text);
    }
  }
  return value;
}

async function handle(request: Request): Promise<void> {
  await booted;
  let pyArgs: { destroy?: () => void } | null = null;
  let reply: unknown = null;
  try {
    pyArgs = toPyArgs(request.args) as { destroy?: () => void } | null;
    reply = bridge!.dispatch(request.call, pyArgs);
    const payload = jsify(reply) as { result?: unknown; error?: unknown } | null;
    if (payload && (typeof payload !== "object" || !("result" in payload) && !("error" in payload))) {
      send({ id: request.id, error: { code: "worker", message: "bridge returned a non-envelope" } });
      return;
    }
    send({ id: request.id, ...payload });
  } catch (error) {
    send({
      id: request.id,
      error: { code: "worker", message: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    pyArgs?.destroy?.();
    (reply as { destroy?: () => void } | null)?.destroy?.();
  }
}

ctx.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as Request & { type?: string };
  if (!data || typeof data.id !== "number" || typeof data.call !== "string") return;
  booted ||= boot().catch((error: unknown) => {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    throw error;
  });
  void handle(data);
});
