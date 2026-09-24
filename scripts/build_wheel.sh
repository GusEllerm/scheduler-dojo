#!/usr/bin/env bash
# Build the pure-Python wheel and stage it for the browser (Pyodide loads it via micropip).
# The wheel MUST be `py3-none-any` (pure Python) or Pyodide cannot import it.
set -euo pipefail
cd "$(dirname "$0")/.."

# The project's Python (3.12) — Pyodide's package format is version-independent for pure wheels,
# but building on the pinned minor keeps `livedocs`/member hashes consistent (see Decision Log).
uv build --wheel

DEST="web/public/wheels"
mkdir -p "$DEST"
rm -f "$DEST"/*.whl 2>/dev/null || true
# Keep the canonical versioned name; the worker references it directly.
cp dist/scheduler_dojo-*.whl "$DEST/"

WHEEL="$(ls -1 "$DEST"/scheduler_dojo-*.whl | head -1)"
if [[ "$WHEEL" != *py3-none-any.whl ]]; then
  echo "ERROR: wheel is not pure (py3-none-any): $WHEEL" >&2
  exit 1
fi
echo "staged wheel: $WHEEL"
