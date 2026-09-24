# Web tier build notes (Stage 4)

- Pyodide runtime pinned to **0.29.5** (CPython 3.12 line) — pin in `web/src/version.ts` only.
- The browser worker installs the pure `py3-none-any` wheel via micropip from `./wheels/*.whl`.
- Bridge protocol: `{ id, call, args }` in → `{ id, result } | { id, error }` out; `args` is a dict
  (kwargs) or list (positional). Python side: `scheduler_dojo.bridge.dispatch`.
