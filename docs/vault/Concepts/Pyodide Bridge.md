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
- **A JS `null` is not Python `None`.** At this pin (0.29.5) a `null` inside posted args arrives as a
  `JsNull` *proxy* — truthy, without `.get`, and `str()`-ing to `"jsnull"` — so it is not the `None`
  a bridge function's default is. Every optional kwarg in
  `web/src/bridge.ts` is **omitted when unset** rather than sent as null (`runLevel`, `startRun`,
  `shareEncode`, `shareReplay`, `progressionView`). That is not pedantry: `share_encode` shipped
  `kata: null` since Stage 9, so sharing a NON-kata run made the engine parse the word `jsnull` as
  kata source (`expected a module (jsnull by name:) or def`), and a null `state` broke
  `progression_view` the same way (`'JsNull' object has no attribute 'get'`). Both found the honest way
  while minting the Art 7b campus card — see [[Campus]].
- **Progress, not a spinner.** The worker reports real load progress (runtime bytes, then wheel) so the
  loading screen is honest; the wheel is cached.

## The stepping API (§4.1)

`bridge.start/step_n/step_until` drive a `Scheduler` that lives across messages, using the **same**
`_advance` loop as a full `run`, so pausing, animating, or hand-placing at any speed produces a run
bit-for-bit identical to the CLI/golden run — phase-two ticks and rings ride that same loop, so a
stepped run on a ring level equals a full one. `step_result` drains and finalizes (the drain respects
the level horizon, so ticks cannot spin it), and `step_close` (TS `bridge.stepClose`) ENDS a session
without draining — pop the handle, run nothing — which is what thumbnail drawers use: a frame
mid-flight has no summary worth computing, and the old `step_result` drain re-ran the rest of the
level per tile (review 7b, Art 8 commit). Snapshots carry the campus picture: real `placed` node
ids, `reserved` cones, per-user `pressure` and `overflow`, and `horizon_end` (t0 + horizon) — the
floor for a browser step-target cap, so a driver's ceiling can never sit below the horizon and
pin the clock (review F1). Stepped runs END at the horizon (done on the stop frame; stepping past
it is safe, not a `DeterminismError`), and `run`/`step_result` carry `overflow_time` — the instant
the ring FILLED, which `end_time` (the last finish) is not (review F5). See
[[scheduler_dojo-sim-scheduler]].

## Failure modes

- *Wheel won't load*: confirm it is `py3-none-any` (`scripts/build_wheel.sh` checks), the URL is
  reachable, and the wheel's target CPython minor matches the runtime's.
- *`dispatch` returns `{error:{code}}`*: that is by design — a structured teaching error, surfaced in
  the UI, never an uncaught throw at the boundary. See [[Concepts/Scoring]], [[Kata]].
