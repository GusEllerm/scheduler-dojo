---
livedocs: code
---
# Pyodide Bridge

> [!abstract] The invariant
> There is **exactly one** implementation of the simulator and of Kata — Python. The browser runs that
> same code inside [[scheduler_dojo-bridge|Pyodide]] via a pure `py3-none-any` wheel; nothing is ported
> to TypeScript. One engine, so the golden, the CLI, the share card, and the browser can never disagree.

## The shape

```
page (bridge.ts)  --postMessage {id,call,args}-->  worker.ts
   worker: loadPyodide(CDN v0.29.5) → micropip.install(wheel) → pyimport bridge
   worker: bridge.dispatch(call, args)  --{id,result|error}-->  page
```

- **One pinned version.** `web/src/version.ts` is the sole place the Pyodide runtime version (and thus
  CPython 3.12) appears; the wheel and the CDN runtime must agree on the CPython minor for compiled
  deps — ours is pure, so it is version-independent, but we still pin to the 3.12 line for consistency
  with `livedocs`/stamps (see [[Decision Log]]).
- **Progress, not a spinner.** The worker reports real load progress (runtime bytes, then wheel) so the
  loading screen is honest; the wheel is cached.

## The stepping API (§4.1)

`bridge.start/step_n/step_until` drive a `Scheduler` that lives across messages, using the **same**
`_advance` loop as a full `run`, so pausing, animating, or hand-placing at any speed produces a run
bit-for-bit identical to the CLI/golden run. `step_result` drains and finalizes. See
[[scheduler_dojo-sim-scheduler]].

## Failure modes

- *Wheel won't load*: confirm it is `py3-none-any` (`scripts/build_wheel.sh` checks), the URL is
  reachable, and the wheel's target CPython minor matches the runtime's.
- *`dispatch` returns `{error:{code}}`*: that is by design — a structured teaching error, surfaced in
  the UI, never an uncaught throw at the boundary. See [[Concepts/Scoring]], [[Kata]].
