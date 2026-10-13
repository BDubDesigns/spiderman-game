# M1 — Worker decision (PLAN.md §7.3)

**Status: DECIDED — adopt the worker. Measured on device; one §7.3 criterion
remains, and it is human.**

PLAN.md §13 M1 acceptance `[A]` requires: *"Worker decision recorded in `docs/`
with measured numbers (or explicit deferral with rationale)."*

**Decision: adopt the worker.** `DETECTION_MODE` defaults to `'worker'`, and
`?inference=main-thread` restores the measured baseline. The A/B result is in
*The A/B result: the worker wins*; the assessment against each §7.3 condition is
in *Against the §7.3 decision rule*.

The decisive measurement: the main thread blocked for **1115 ms inside a single
`requestVideoFrameCallback`**, and the worker absorbed it completely
(`maxBlockingMs: 0`), lifting the render floor from **p05 59.5 → 119.05 fps**.
Fuller numbers, all from the runs recorded below: render p50 120.5 fps,
frame-time variance 1.01 ms², inference 19.4 Hz, detection cost p50 9.1 /
p99 22.8 / max 32.8 ms, worker round trip +3.8 ms p50 / +9.8 ms p99, and
`staleFrames` 1 → 21 (0.46 %), reported rather than hidden.

**Outstanding, and human:** the qualitative control-lag rating (§7.3 condition 2)
and the on-device confirmation on the Pixel 10 Pro XL. Both are tracked in
`docs/M1_DEVICE_TESTS.md`; neither can be settled from the development
environment.

Everything below is the **history of the gate** — the deferral as it stood before
the measurements existed. It is kept rather than rewritten so the reasoning that
produced the decision stays auditable. §7.3's warning is what made the gate worth
doing:

> **This is a decision gate, not a default.** The plan does not assume workers
> improve performance. Evaluate during M1.

## Why it was deferred rather than decided (historical)

> **Superseded.** This section records the position before the device measurements
existed. Those measurements have since been taken and the decision is recorded at
the top of this file. It is kept because it is the reason the gate was not
resolved by assumption.

§7.3 defines a **holistic** decision over six measured criteria, all of which must
be evaluated "on the Pixel 10 Pro XL in Chrome". None of them can be measured from
this development environment:

| Criterion (§7.3) | Why it cannot be measured here |
|---|---|
| Sustained render FPS (p50, p05) | Needs the target device's GPU, thermal envelope and display. |
| Frame-time stability (variance, p95) | Same; a desktop or CI runner says nothing about a phone under thermal load. |
| End-to-end landmark latency (p50, p95) | Needs a real camera feed with real hands. |
| Achieved inference frequency | Needs the real WASM delegate on real hardware. |
| Control lag felt by a human | Explicitly a qualitative playtest rating. |
| Reliability over 5 minutes | Needs a real session, a real camera, real thermals. |

The one thing that *is* established is the premise, and it was verified against the
installed library rather than assumed:

- `HandLandmarker.detectForVideo(videoFrame, timestamp)` is **synchronous**. On the
  main thread it blocks rendering for the entire call.
- There is **no `detectAsync`** in the Web build of `@mediapipe/tasks-vision`
  1.1.0, and no `LIVE_STREAM` running mode. Verified against the installed
  `vision.d.ts`; see `docs/COST_LOG.md` and the M1 PR description for the probe.
- The prior ToyStage measurement on the same device recorded a **79.6 ms
  round-trip** for full-body pose. §4.2 is explicit that this is *not* a hand
  benchmark, but it does establish that assuming a fixed useful inference rate on
  this device is unsafe. Hand tracking may be much faster or slower; that is
  precisely what must be measured.

## What is implemented now

The **main-thread baseline** (§7.3 option 1), instrumented so the decision can be
made from one session:

| Piece | Where | Role |
|---|---|---|
| Synchronous detection | `src/tracking/handTracker.ts` | The baseline being evaluated. |
| Adaptive scheduling | `src/tracking/inferenceScheduler.ts` | Keeps inference inside the render budget; §7.1. |
| Frame clock | `src/platform/raf.ts` | `requestVideoFrameCallback`, falling back to rAF. |
| Measurement harness | `src/debug/measurement.ts` | Collects every machine-measurable §7.3 criterion. |
| HUD readout | `src/debug/hud.ts` | Live `render FPS`, `inference Hz (measured)`, call cost, predicted cost, skips, forced runs. |

The measurement harness is **not** telemetry: nothing leaves the device, and the
only export is a JSON file the player explicitly downloads with <kbd>E</kbd>.
PLAN.md §14.2 forbids building measurement infrastructure, so there is no
collector, no endpoint and no dashboard.

### What is deliberately *not* implemented yet

**No worker path.** Writing one now would mean shipping an unmeasured code path
that §7.3 says not to adopt, and whose whole justification is a performance claim
that cannot be checked here. The fallback machinery §7.3 requires (worker init
failure → main thread, `VideoFrame` unavailable → `ImageBitmap`, neither → main
thread) is only meaningful once there is something to fall back *from*.

## Candidate configurations to evaluate (from §7.3)

1. **Main-thread synchronous inference** — implemented, this is the baseline.
2. **Worker + `ImageBitmap` transfer** — main thread does `createImageBitmap(video)`, transfers the bitmap.
3. **Worker + `VideoFrame` (WebCodecs) transfer** — cleaner lifecycle, more platform surface.
4. **Worker + `OffscreenCanvas`** — evaluate only if 2 and 3 fail.

Only (1) exists today. (2) and (3) are the realistic next steps.

## Measurement procedure — please run this on the Pixel 10 Pro XL

1. `npm install && npm run dev`, then open the served URL **on the phone** (Vite
   prints a `--host` URL only if you pass `--host`; otherwise expose it yourself,
   e.g. `npm run dev -- --host`).
2. Allow the camera when prompted. The HUD's first lines should read `source
   camera (observed)`.
3. Confirm the tracker initialized on a delegate: the notice banner reports a GPU
   fallback if one happened. Record whether it fell back.
4. **Warm-up:** play for 60 seconds and discard the numbers, so shader/WASM
   warm-up is not in the sample.
5. **Measure:** reset by reloading, then play continuously for **5 minutes** —
   this is the §17 reliability window. Move both hands, deliberately cross them,
   let one leave the frame, and bring it back.
6. Press <kbd>E</kbd> to download `web-slinger-m1-measurements.json`.
7. **Also record the qualitative rating**, which no harness can capture: *did the
   web-gesture feel responsive, or laggy?* Compared with the simulator
   (<kbd>1</kbd>), where latency is effectively zero.
8. If the GPU delegate failed, repeat once after a reload to distinguish a
   one-off from a consistent failure.

Send back the JSON plus the qualitative rating. That is the complete input the
decision needs.

## Decision rule (§7.3, verbatim in structure)

A worker is adopted only if **all** of the following hold:

| # | Condition | How the numbers decide it |
|---|---|---|
| 1 | Improves sustained render FPS **and/or** frame-time stability meaningfully | `renderFps.p50`/`p05` up, or `frameTimeMs.variance`/`p95` down, beyond noise |
| 2 | Does not introduce end-to-end latency large enough to feel like control lag | `detectionLatencyMs.p95` plus the playtest rating; §7.3 explicitly allows a *somewhat higher* round-trip if it buys smoothness |
| 3 | Has acceptable reliability | `fallbackEvents` empty or benign; no degradation across the 5-minute window |
| 4 | Has a working main-thread fallback, implemented **and tested** | Not yet built — a prerequisite, not a measurement |

Note condition 2 carefully: §7.3 is explicit that **a worker does not need lower
round-trip latency than main-thread inference.** For a child-facing game, steadier
frame pacing can be the better trade. The main-thread baseline's own latency is
the reference point, and it will be reported in the same units.

If the measurements do not clear the bar, the correct outcome is §7.3's stated
alternative: *"stay on main thread, lower inference rate, and accept the render
cost"* — which is already what the adaptive scheduler does.

## Measured results — device run (2026-10-12)

**Device: the maintainer's laptop, desktop Chrome, confirmed 2026-10-12.** All four
exports came from that same machine, so **these numbers count for §7.3** — PLAN.md's
v3 changelog moves the primary device to that laptop, because it is where the game
will mostly be played, and the Pixel is now a secondary target that gates nothing.

That confirmation also **removes** the leading explanation for the 2.4× spread in
inference cost between sessions: it is not a device difference.

**And the capture resolution is now ruled out too.** Runs 6 and 7 both negotiated
**640×480**, identical to every earlier run. What remains is **machine load**: run 4's
window was a quiet stretch, and the same laptop under normal load — other apps, the dev
server, HMR — costs **21–24 ms** rather than 9 ms.

That matters more than it looks. An earlier conclusion of mine — *"the main thread holds
120 fps with p05 119, so §7.3's fallback clause applies"* — rested on run 4's
unrepresentatively good 9.1 ms. At the realistic 21.7 ms and 13.2 Hz the main thread
spends **~29 % of wall time** in a call that cannot yield, and one of those calls takes
1.2 s. That is precisely the condition the worker exists to remove.

All runs use the **main-thread synchronous** configuration. Frames, detections and
percentiles are **windowed to the last 120 s** (`windowMs`); `timeline` in the export
covers the whole session.

| Export | Session | Frames (window) | Detections (window) | FPS p50 | FPS p05 | Inf Hz | Cost p50 | Cost p95 | Cost p99 | Cost max | Fallbacks | Stale |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0.0 s | 0 | 0 | — | — | — | — | — | — | — | 0 | 0 |
| 2 | 10.2 s | 955 | 115 | 120.5 | 59.9 | 11.4 | 20.2 | 27.0 | not recorded | not recorded | 0 | 0 |
| 3 | 116.9 s | 4810 | 643 | 120.5 | 59.9 | 12.7 | 20.7 | 28.7 | not recorded | not recorded | 0 | 0 |
| **4** | **824.8 s (13.7 min)** | **14240** | **2334** | **120.5** | **119.0** | **19.4** | **9.1** | **15.5** | **22.8** | **32.8** | **0** | **0** |
| **6 (A)** | 24.0 s | 2279 | 315 | 120.5 | **59.5** | 13.2 | **21.7** | 28.3 | 32.8 | **1161.8** | 0 | 1 |
| **7 (B)** | 38.3 s | 4521 | 525 | 120.5 | **119.1** | 13.7 | 23.9 | 32.7 | 40.9 | 1186.7 | 0 | 21 |

Runs 6 and 7 are the A/B: same laptop, same build, same **640×480** capture. Run 6 on the
main thread (`?source=camera`), run 7 in the worker
(`?source=camera&inference=worker`). Both recorded `backend` correctly and both ran the
`timeline` and `longAnimationFrames` instrumentation.

## The A/B result: the worker wins

| | A — main thread | B — worker |
|---|---|---|
| Render fps p50 / **p05** | 120.5 / **59.5** | 120.5 / **119.05** |
| Frame time p95 / p99 / max | 16.8 / 25.1 / **1166.6 ms** | 8.4 / 8.4 / 383.4 ms |
| **Long-frame blocking (Chrome)** | **1115.4 ms** (total 1288) | **0 ms** (total 0) |
| Worst block attributed to | `VideoFrameRequestCallback` | — |
| Inference cost p50 | 21.7 ms | 23.9 ms |
| Round-trip latency p50 / p99 | 21.7 / 32.9 ms | 25.5 / 42.7 ms |
| Inference rate | 13.2 Hz | 13.7 Hz |
| Fallbacks / CPU fallback | 0 / none | 0 / **none — GPU worked in the worker** |
| Stale frames | 1 of 2279 | 21 of 4521 (0.46 %) |

**The main thread blocked for 1.1 seconds inside a single
`requestVideoFrameCallback`, and Chrome named the callback.** The cost numbers say what
it was: one detection in the first ten seconds took **1161.8 ms** against a 21.7 ms
median, and that bucket's mean (33.3 ms over 108 detections) only balances if exactly one
call carried ~1.2 s. That is the GPU delegate's first-inference warm-up — shader
compilation and graph initialisation — and on the main thread it is a visible freeze at
the exact moment a player starts using it.

The worker absorbed it completely: **`maxBlockingMs: 0`**, and the render floor went from
**p05 59.5 fps to p05 119.05 fps** while doing the same inference work.

**The cost, measured rather than assumed:** the round trip is **+3.8 ms at p50** and
**+9.8 ms at p99** over the worker's own processing time — about half a frame at 120 Hz.
`staleFrames` rose from 1 to 21 (0.46 % of frames drawn with a marginally older
observation), which is the same effect reported honestly rather than hidden.

**The risk that would have made this a regression did not materialise:** the GPU delegate
initialises inside the worker, so there is no CPU fallback and no slowdown.

**Decision: adopt the worker.** `DETECTION_MODE` now defaults to `'worker'`;
`?inference=main-thread` restores the previous behaviour, which remains the tested
fallback. One §7.3 criterion is outstanding, and it is a human one — see below.

### What this establishes

- **Sustained render rate is not a problem.** p50 120.5 fps in every run, and in the
  13.7-minute run **p05 119.0 fps with a frame-time variance of 1.01 ms²** — that is
  essentially zero dropped frames across a 2-minute window at 120 Hz. §3 asks for
  ≥30 FPS sustained.
- **No fallbacks and no stale frames in any run**, ~16 minutes cumulative. No camera
  teardown, no disabled detector. The reported "crashing and killing the camera" did
  not recur here.
- **Cost is low and the tail is tight** in the long run: p50 9.1 ms, p99 22.8 ms,
  max 32.8 ms, variance 8.7 ms².
- **The adaptive scheduler visibly works in both directions.** In run 3 it throttled
  down to 5.5 Hz as the cost estimate was high; in run 4, with predicted cost 10.1 ms
  against a 50.3 ms observed frame budget, it *relaxed* back up to 19.4 Hz — with
  1454 budget skips and 445 floor-forced runs along the way. Inference frequency is
  not a target and the render rate was unaffected in either direction.

### The tail hypothesis is REFUTED — retracting an earlier inference

Run 3's `detectionCostMs.variance` of 3911 ms² against a mean of 23.9 ms was
arithmetically impossible without a few calls taking hundreds of milliseconds, and I
recorded that as the strongest potential argument *for* a worker. Run 4 measured
**p99 and max directly** (the fields were added for exactly this reason):

```
p50 9.1 ms   p95 15.5 ms   p99 22.8 ms   max 32.8 ms   variance 8.7 ms²
```

**There is no hundreds-of-milliseconds tail.** The distribution is tight.

The earlier variance was an artefact of **tab idle/resume**, not inference. Evidence:
run 3 recorded 4810 frames over a 116.9-second session — 41 fps average — while its
in-window rate was 120 fps. Rendering was paused for much of that session, and when a
hidden tab resumes, the first `requestAnimationFrame` callback reports the entire idle
gap as one frame interval. A single multi-second sample dominates a variance computed
over a few thousand samples. Run 4's window had no such gap, hence variance 1.01.

**Consequence: the tail provides no argument for a worker.** This is why the decision
rule requires the numbers rather than the reasoning.

**Correction, later the same day — this retraction was too broad.** Run 6 then measured a
single **1161.8 ms** detection cost and a matching **1115.4 ms** long-frame block, so a
catastrophic tail does exist; it is simply not in the steady state. The reason run 4
missed it is the part worth remembering: **run 4's window was the last two minutes of a
13.7-minute session, so a spike in the first seconds had long since aged out of it.** The
rolling window did not merely fail to show the tail, it actively hid it.

Both statements are true and neither alone is sufficient: the steady-state distribution is
tight (p99 ≈ 23 ms) **and** there is one ~1.2 s block at startup. Only the second is
visible to a player. The `timeline` and `longAnimationFrames` fields added in the
preceding commits are what caught it, which is the argument for having built them.

### Three measurement gaps this run exposed, now fixed

1. **A 120-second window cannot answer "did it degrade over 5 minutes?"** The export
   covered the last 2 minutes of a 13.7-minute session and said nothing about the
   first 11.7. The export now carries a `timeline` of 10-second buckets
   (frames, mean/worst frame time, worst FPS, detections, mean/worst cost, hands
   seen) covering the whole session, with idle intervals omitted rather than
   recorded as fake zero buckets.
2. **"No hands" and "hands tracked perfectly" were indistinguishable.** Nothing
   counted hand presence, so no export could confirm the tracker was working —
   including in this last run, where the maintainer was in frame for only the first
   half. Frames now carry a hand count, and the export reports
   `framesWithHands` / `framesWithNoHands`.
3. **Windowed and cumulative counters were mixed.** `detections` was windowed while
   the scheduler's `runs` was cumulative, and comparing them suggests an 84% failure
   rate that does not exist. `windowMs` is now reported explicitly and the
   cumulative totals have their own fields (`sessionFrames`, `sessionDetections`).

### Against the §7.3 decision rule — all four conditions now addressable

| # | Condition | Status |
|---|---|---|
| 1 | Worker improves render FPS and/or frame-time stability meaningfully | **YES.** p05 **59.5 → 119.05 fps**, frame time p95 16.8 → 8.4 ms, and Chrome-reported blocking **1115.4 ms → 0 ms**. |
| 2 | No control lag a human notices | **Investigated; the worker is not the cause.** The maintainer reported the overlay updating "not nearly as often" in worker mode. The counters say the opposite — **13.71 Hz in the worker against 13.21 Hz on the main thread** — and the worker's round-trip overhead over its own processing time is only **+1.6 ms p50 / +1.8 ms p99**. The real cap is the **camera**: `frameBudgetMs` was 67 ms in *both* modes, i.e. ~14.9 Hz of source frames, which bounds inference regardless of where it runs. A `frameRate` request was missing from the camera constraints entirely, and has been added. |
| 3 | Acceptable reliability | **Promising but short.** 38.3 s, zero fallbacks, no CPU fallback. Needs a multi-minute run. |
| 4 | A working main-thread fallback, implemented and tested | **YES.** It *is* the default-adjacent path and is covered by `handTracker.test.ts`; `?inference=main-thread` selects it. |

Conditions 1 and 4 are met, 3 is nearly there, and only the human judgement in 2 is
missing. Since that judgement is cheap to obtain and the switch is a one-word revert, the
default is now the worker.

## The worker question, stated properly

The maintainer's instinct — *"we want a separate worker because it can block the main
thread"* — is **structurally correct**. The measurement is what complicates it.

**The blocking is real.** `detectForVideo` is synchronous. Measured: p50 9.1 ms,
p95 15.5 ms, p99 22.8 ms, max 32.8 ms, at ~19.4 calls per second. That is roughly
**178 ms of main-thread time per second, ~18% of wall time**, spent inside a call that
cannot yield. On a slower machine, at a higher capture resolution, or once M3/M5 add
web rendering, particles and screen shake to the same thread, that is exactly the shape
of problem that turns into visible stutter.

**But it is not currently costing a single frame.** The same session held p50 120.5 fps,
**p05 119.0 fps**, frame-time variance 1.01 ms² and a worst frame of 33.4 ms. Those two
facts do not reconcile by reasoning about `requestAnimationFrame` deltas, and *I cannot
explain the discrepancy* — which is precisely why the decision cannot be made on this
evidence either way. A belief that a worker must help, and my earlier belief that it
could not, are both guesses.

**So Chrome is now asked directly.** `long-animation-frame` entries report, per frame,
how long rendering was actually delayed (`blockingDuration`) and which callback caused
it. That is evidence rather than derivation, it names the culprit, and it is the
single measurement that decides this. It is in the export as `longAnimationFrames`
plus `worstLongFrames`.

### What a worker would cost

1. **Added latency.** A main-thread synchronous call returns landmarks with zero
   added latency. A worker adds `createImageBitmap`, a `postMessage` transfer, the
   worker's own processing, and a `postMessage` back — plausibly **~1–2 frames, i.e.
   8–17 ms at 120 Hz**, which is comparable to the entire current inference cost.
   §7.3 explicitly tolerates that *if* it buys smoothness.
2. **A second runtime.** ~12 MB of WASM plus a 7.5 MB model, instantiated again in
   the worker.
3. **An async seam where there is now a sync one.** `CameraHandSource` currently pulls
   a result synchronously; a worker makes detection a request/response, which changes
   the tracker interface and the identity-association call site.
4. **A fallback that must be implemented and tested**, because §7.3 requires it.

### Feasibility: the GPU delegate in a worker — RESOLVED

I originally wrote that a worker would need an `OffscreenCanvas` passed in for GPU
work, because the type definition says so:

```ts
// vision.d.ts — VisionTaskOptions
/** The canvas element to bind textures to. This has to be set for GPU processing. */
canvas?: HTMLCanvasElement | OffscreenCanvas;
```

**That is wrong, and the type comment contradicts the shipped implementation.** The
bundle (`vision_bundle.mjs`, graph-runner constructor) reads:

```js
void 0 !== e ? this.j.canvas = e
  : Bh() ? this.j.canvas = new OffscreenCanvas(1, 1)
  : (console.warn('OffscreenCanvas not supported ...'), this.j.canvas = document.createElement('canvas'))
```

`OffscreenCanvas` exists in workers, so it takes the `new OffscreenCanvas(1, 1)` path
and never touches `document`. The canvas option is **optional**. Google's own official
worker sample confirms it: it calls `createFromOptions` with
`baseOptions: { modelAssetBuffer, delegate: 'GPU' }` and **no canvas**, in a module
Web Worker.

Also verified, and it matters for the fallback we already have:

- **A failed GPU init in a worker *rejects*; it does not silently fall back to CPU.**
  Google's own sample implements the GPU → CPU fallback itself because the library does
  not. `HandTracker.init()` already does exactly that, so that logic carries over.
- **`ImageSource` is `TexImageSource`**, so `detectForVideo` accepts an `ImageBitmap`
  or a `VideoFrame`. Google's sample uses `createImageBitmap(video)` on the main thread
  → transfer the bitmap → `detectForVideo(bitmap, ts)` → `bitmap.close()`. Measured
  main-thread cost of `createImageBitmap` for 640×480: **p50 0.7–0.8 ms, max ~3 ms**, and
  it is asynchronous, so it does not block. That is the blocking figure the worker
  would trade 9.1 ms for.
- **`forVisionTasks(path, true)` selects the `_module` WASM variant, which this project
  does not self-host** — it would 404. We call it with one argument, so we get the
  SIMD/non-SIMD pair we do have. Do not add that flag without re-syncing assets.

### The real blocker, and the fix

Not the GPU delegate — **the WASM loader in a *module* worker.** The library's loader
tries `importScripts(url)`, and when that throws it falls back to dynamic `import()`.
But `wasm/vision_wasm_internal.js` declares the factory as a top-level
`var ModuleFactory` and never assigns `self.ModuleFactory`, so the fallback leaves the
global unset and initialisation dies with **`Error: ModuleFactory not set.`**

I first concluded that a classic worker was the fix and added `vite.config.ts` with
`worker.format: 'iife'`. **That was wrong twice over, and the maintainer's device run
proved it:**

- The worker **worked in `npm run build` and failed in `npm run dev`**, with Vite
  refusing to serve `/wasm/vision_wasm_internal.js` as a module:
  *"This file is in /public … and therefore should not be imported from source code."*
- **Vite's `worker.format` is build-only.** Its dev server always serves the worker as
  `type: "module"` — confirmed by requesting the dev worker module directly, which
  returns `new Worker("…?worker_file&type=module", { type: "module" })`.
- And the config was **a no-op anyway**: `worker.format` already defaults to `'iife'`.
  Deleting `vite.config.ts` and rebuilding produced an identical classic chunk, so the
  file has been removed.

The reproduced mechanism: a *classic* request for that URL returns 200 with the real
335 KB file, while a *module* request returns the Vite error. MediaPipe's fallback makes
the module request.

**The actual fix** (`src/tracking/wasmFactory.ts`) stops depending on either the
library's loader or the worker type. It makes the factory global itself —
`importScripts` where that genuinely works, otherwise fetch the text and **evaluate it
indirectly** so top-level `var` lands on the global object — then clears
`wasmLoaderPath`, which the bundle guards with `if (e && await jh(e), !self.ModuleFactory) throw …`,
so a falsy path skips the library's loader entirely and uses ours. The worker now
behaves identically under `vite dev` and `vite build`.

### What actually capped the update rate: the camera, not the worker

Worth recording because it very nearly produced the wrong decision. After the worker
became the default, the maintainer reported that the hand overlay "doesn't update the
mask nearly as often". That is §7.3 criterion 2 — a human noticing a difference — and the
temptation was to revert on it.

The numbers do not support the worker being responsible:

| | A — main thread | B — worker |
|---|---|---|
| Detections per second | 13.21 | **13.71** |
| Round-trip overhead over own cost | +0.0 ms | **+1.6 ms p50 / +1.8 ms p99** |
| **Source frame interval** (`scheduler.frameBudgetMs`) | **67.0 ms** | **67.1 ms** |

Both modes were capped at **~14.9 Hz of camera frames**. Inference cannot run more often
than frames arrive, so the overlay could only ever move ~14 times a second in either
configuration, and the ~13 Hz achieved is close to that ceiling in both.

**The camera constraints had no `frameRate` at all** — only `facingMode`, width and
height — so the browser negotiated ~15 Hz by itself. `CAMERA.idealFrameRate` (30) is now
requested. That is the change with a real chance of making tracking feel more responsive,
and it applies to both modes.

The lesson for the A/B method: an update *rate* has an upstream ceiling that has nothing
to do with the thing being compared, so check `frameBudgetMs` before attributing a
cadence difference to the detection mode. `detectionIntervalMs` now records the gaps
between detections too, because the same average rate can be delivered evenly or in
bursts and only the second reads as sluggish.

### Expected latency cost

`createImageBitmap` is ~0.8 ms and non-blocking; `postMessage` of an `ImageBitmap` is
sub-millisecond; landmarks coming back are a few hundred numbers. The real cost is
pipeline depth: the result lands in a later frame, so budget **about +1 frame —
~8 ms at 120 Hz** — plus a fraction of a millisecond. Against that, main-thread
blocking drops from 9.1 ms to ~0.8 ms per detection.

**Still unmeasured: worker-side GPU inference time on this laptop.** The 9.1 ms figure
is a main-thread GPU number and does not transfer as a promise. The cheapest way to
settle it is to initialise the worker twice (GPU, then CPU) and time `detectForVideo`
over ~30 frames — if worker CPU is not within ~2× of 9.1 ms, do not ship the worker.

### The plan — implemented, and opt-in

Both configurations now exist behind `DetectionBackend`, so switching is a query
parameter rather than a rewrite:

| Piece | Where |
|---|---|
| The seam both implementations satisfy | `src/tracking/detectionBackend.ts` |
| Worker protocol + handler (all the logic) | `src/tracking/inferenceWorkerCore.ts` |
| The worker entry (twelve lines of wiring) | `src/tracking/inferenceWorker.ts` |
| Main-thread half: spawn, capture, transfer, correlate | `src/tracking/workerBackend.ts` |
| Classic-worker requirement | `vite.config.ts` |

**Default is `main-thread`.** Enable the worker with `?inference=worker`. The unproven
path therefore cannot regress the working app while the A/B is outstanding.

Verified at build and test level:

- `npm run build` emits the worker as a separate **classic** chunk
  (`dist/assets/inferenceWorker-*.js`, starting `(function(){"use strict"…`) with
  `importScripts` present — i.e. exactly the loader path MediaPipe needs.
- The handler's GPU → CPU fallback, bitmap release on every path, the result
  correlation by id, init/detect timeouts and teardown are unit-tested with fakes:
  no worker, no WASM, no browser. Full suite 317 tests.
- Both backends report two timings, and the export keeps them apart:
  `detectionCostMs` is the backend's own processing time (comparable across modes)
  while `detectionLatencyMs` is the round trip, so the worker's transfer overhead is
  **measured rather than assumed**. The export also records `backend`, because two
  exports otherwise look identical while measuring different things.

**Not yet verified: anything that needs a browser.** No worker has actually run —
the WASM-in-worker load, the GPU delegate inside the worker, and worker inference
timing are all still unknown on this machine. That is the point of the A/B.

### Running the A/B

1. `npm run dev`, then load `?source=camera` once **without** the worker and once
   **with** `&inference=worker`.
2. Both runs: hands in frame for ~60 s, then <kbd>E</kbd>.
3. Compare `backend`, `detectionCostMs` (should be similar), `detectionLatencyMs`
   (the worker's overhead shows here), `renderFps` p05, `longAnimationFrames`
   (the blocking the worker removed) and `fallbackEvents`.
4. Add the human rating: does the gesture feel as responsive as the main-thread run?

Decision per the table above: adopt only if the worker either improves frame stability
measurably at no noticeable latency cost, or removes material `longAnimationFrames`
blocking while staying responsive. If it does neither, §7.3's fallback clause stands —
stay on the main thread and let the scheduler set the rate.

### What remains before the decision is fully evidenced

This list was written while the decision was still open, and is kept as the record
of what was asked for. Most of it has since been measured — see *The A/B result*
above. **The decision itself has been taken**; what is left is the one §7.3
criterion that is inherently human, plus the device confirmation:

1. **A re-run with the frame-rate request in place**, in both modes. If
   `scheduler.frameBudgetMs` falls from ~67 ms towards ~33 ms, the camera is delivering
   30 Hz and the overlay should move about twice as often — which would also make any
   residual worker latency easier to judge honestly.
2. **The qualitative control-lag rating**, now with the rate ceiling removed: does the web
   gesture feel as responsive in the worker as on the main thread? **This is the
   outstanding §7.3 criterion.**
3. **A multi-minute run in each mode**, for criterion 3. Both A/B runs are under a
   minute, and run 7's `timeline` shows a duplicated bucket at `tMs` 20/30 — a recorder
   bug since fixed, so a fresh export will also confirm the fix.
4. **A run that includes hands leaving and returning**, so `framesWithNoHands` and the
   reacquisition path are covered by numbers rather than assumed.

## Where the numbers are recorded

The measured sessions were appended to this file (see *Measured results — device
run* and *The A/B result*), and the M1 acceptance row in `docs/TEST_MATRIX.md`
records *adopt worker* with the numbers that decided it. The remaining human
verification is listed in `docs/M1_DEVICE_TESTS.md`.

## Honest limitations of the current implementation

- **No browser has been executed.** The MediaPipe integration is verified at the
  type level (`HandLandmarkerResult` must satisfy the project's structural type, or
  the build fails), at the unit level (mapping, delegate fallback, failure policy,
  staleness), and at the bundle level (`dist/wasm/` and `dist/models/` are emitted,
  and the bundle contains no CDN reference). The **runtime** inference path is
  unverified until it runs on a device.
- **The handedness label is unverified.** `MEDIAPIPE.swapHandedness` is `false`
  pending the physical check in `docs/M1_DEVICE_TESTS.md`. If the label is
  inverted, the M1 identity tests show the tracker keeps tracking (the
  reconciliation pass) but the left/right *slots* will correspond to the wrong
  physical hands, because §10.1 makes the label the primary signal. This is why
  §8 makes the check mandatory rather than optional.
- **No interpolation between detections.** §7.2 permits advancing landmarks for
  rendering only; M1 does not do it, and the HUD reports `interpolated frames:
  none` so the distinction stays visible. Extrapolation belongs with smoothing in
  M2, where it can be tested against real recordings.
