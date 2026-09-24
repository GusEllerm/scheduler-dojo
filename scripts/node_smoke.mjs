#!/usr/bin/env node
/**
 * Web-tier acceptance test: run the *real* Python engine under Pyodide in Node and assert the
 * browser's compute path reproduces the goldens.
 *
 *   1. Pins (Pyodide version + wheel name) are read out of web/src/version.ts — the single source
 *      of truth — so this test cannot drift from what the worker loads.
 *   2. The runtime loads from `web/node_modules/pyodide` (offline, from npm) with `indexURL` as a
 *      filesystem path; package wheels npm does not ship (micropip) come from the CDN.
 *   3. A throwaway static server roots at `web/public`, exactly like the dev server, so micropip
 *      installs the engine over `http://127.0.0.1:<port>/wheels/*.whl` (the production path).
 *   4. `bridge.dispatch("run", …)` must reproduce tests/goldens/levels.json hashes + scores, and
 *      `check_kata` must accept the reference kata.
 *
 * Run: `node scripts/node_smoke.mjs` (or `npm run smoke` from web/). Exits non-zero on mismatch.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "web");
const PUBLIC = path.join(WEB, "public");
const PYODIDE_DIR = path.join(WEB, "node_modules", "pyodide");
const VERBOSE = process.env.SMOKE_VERBOSE === "1";

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

// --- pins (web/src/version.ts is the only truth) ----------------------------------------

const pins = await readFile(path.join(WEB, "src", "version.ts"), "utf8");
const pyodideVersion = /PYODIDE_VERSION\s*=\s*"([^"]+)"/.exec(pins)?.[1];
const wheelName = /WHEEL_NAME\s*=\s*"([^"]+)"/.exec(pins)?.[1];
if (!pyodideVersion || !wheelName) fail("could not read PYODIDE_VERSION / WHEEL_NAME from web/src/version.ts");
const cdnBase = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`;
const wheelPath = path.join(PUBLIC, "wheels", wheelName);
if (!existsSync(wheelPath)) {
  fail(`${path.relative(ROOT, wheelPath)} missing — run \`bash scripts/build_wheel.sh\` first`);
}

const level1 = JSON.parse(await readFile(path.join(ROOT, "levels", "level1.json"), "utf8"));
const goldens = JSON.parse(await readFile(path.join(ROOT, "tests", "goldens", "levels.json"), "utf8"));
const golden = goldens["level1.json"];
const kataText = await readFile(path.join(ROOT, "levels", "reference_katas", "shortest_first.kata"), "utf8");

// --- static server over web/public (mirrors the dev server's publicDir) ------------------

const MIME = {
  ".whl": "application/octet-stream",
  ".json": "application/json",
  ".py": "text/plain",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const file = path.resolve(PUBLIC, "." + path.posix.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(address.port));
  });
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const wheelUrl = `http://127.0.0.1:${port}/wheels/${wheelName}`;

// --- pyodide -----------------------------------------------------------------------------

if (!existsSync(PYODIDE_DIR)) fail("pyodide missing — run `npm install` in web/");
const { loadPyodide } = await import(pathToFileURL(path.join(PYODIDE_DIR, "pyodide.mjs")).href);

// In Node the runtime files (`pyodide.asm.js/.wasm`, `python_stdlib.zip`) are imported relative
// to the npm module, so `indexURL` must be a *filesystem path* — and the runtime cannot be
// fetched from a URL here. Only *package* wheels can fall back to the CDN (see below).
const localIndex = PYODIDE_DIR + path.sep;
const stdio = {
  stdout: (text) => (VERBOSE ? process.stdout.write(`${text}\n`) : undefined),
  stderr: (text) => process.stderr.write(`${text}\n`),
};
const pyodide = await loadPyodide({ indexURL: localIndex, ...stdio });

// npm ships the runtime but not the package wheels, so a package that is absent locally is
// fetched by absolute URL from the CDN — the same bytes the browser worker downloads.
const lock = JSON.parse(await readFile(path.join(PYODIDE_DIR, "pyodide-lock.json"), "utf8"));
const micropipFile = lock?.packages?.micropip?.file_name;
const micropipTarget =
  micropipFile && existsSync(path.join(PYODIDE_DIR, micropipFile))
    ? "micropip"
    : `${cdnBase}${micropipFile}`;
await pyodide.loadPackage(micropipTarget);

await pyodide.runPythonAsync(
  `import micropip\nawait micropip.install(${JSON.stringify(wheelUrl)})\nfrom scheduler_dojo import bridge`,
);
const bridge = pyodide.globals.get("bridge");

/**
 * Exactly the worker's marshalling, so this exercises the real conversion: `pyodide.toPy` turns
 * the kwargs object into nested dicts/lists (what `dispatch` expects as `dict | list`), and the
 * reply comes back through `toJs({dict_converter: Object.fromEntries})` — without that converter
 * the reply would be `Map`s, which is not what the page may consume.
 */
function call(name, args) {
  const pyArgs = args === undefined || args === null ? null : pyodide.toPy(args);
  const reply = bridge.dispatch(name, pyArgs);
  const envelope = reply.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
  pyArgs?.destroy?.();
  reply.destroy?.();
  if (envelope.error) fail(`${name} -> ${envelope.error.code}: ${envelope.error.message}`);
  return envelope.result;
}

try {
  const info = call("version");
  console.log(`pyodide ${pyodide.version} · scheduler_dojo ${info.version} · wheel ${wheelUrl}`);

  const idle = call("run", { level: level1, policy: "idle" });
  if (idle.trajectory_hash !== golden.baseline_hash) {
    fail(`idle trajectory_hash mismatch\n  expected ${golden.baseline_hash}\n  actual   ${idle.trajectory_hash}`);
  }
  if (idle.score !== golden.baseline_score) {
    fail(`idle score mismatch: expected ${golden.baseline_score}, got ${idle.score}`);
  }
  console.log(`idle   hash=${idle.trajectory_hash} score=${idle.score}`);

  const report = call("check_kata", { kata: kataText });
  if (!report.ok) fail(`check_kata rejected shortest_first.kata: ${JSON.stringify(report.errors)}`);
  console.log(`kata   ok=true errors=[]`);

  const reference = call("run", { level: level1, policy: "kata", kata: kataText });
  if (reference.trajectory_hash !== golden.reference_hash) {
    fail(
      `reference kata trajectory_hash mismatch\n  expected ${golden.reference_hash}\n  actual   ${reference.trajectory_hash}`,
    );
  }
  console.log(`kata   hash=${reference.trajectory_hash} score=${reference.score}`);

  // A broken level must arrive as an error envelope, never a throw across the boundary.
  const broken = bridge.dispatch("run", pyodide.toPy({ level: { id: "broken" } }));
  const envelope = broken.toJs({ dict_converter: Object.fromEntries });
  broken.destroy?.();
  if (!envelope.error) fail("invalid level did not produce an error envelope");
  console.log(`error  envelope ok (${envelope.error.code})`);

  console.log(
    `OK  level1 baseline_hash=${golden.baseline_hash} score=${golden.baseline_score} ` +
      `reference_hash=${golden.reference_hash} (pyodide ${pyodide.version}, ${wheelName})`,
  );
} finally {
  bridge.destroy?.();
  server.close();
  try {
    pyodide.destroy?.();
  } catch {
    /* runtime already torn down */
  }
}

// The runtime can leave a handle behind; make sure the process still exits.
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref?.();
