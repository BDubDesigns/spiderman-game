# M1 — Worker decision (PLAN.md §7.3)

**Status: DEFERRED, pending on-device measurement.**

PLAN.md §13 M1 acceptance `[A]` requires: *"Worker decision recorded in `docs/`
with measured numbers (or explicit deferral with rationale)."*

This is the explicit deferral, with the rationale, the exact measurements needed,
and the rule that will decide it. **No decision has been made, and nothing here
should be read as a recommendation.** Adopting a worker without the numbers would
be exactly the assumption §7.3 was written to prevent:

> **This is a decision gate, not a default.** The plan does not assume workers
> improve performance. Evaluate during M1.

## Why it is deferred rather than decided

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

**Device: STILL NOT RECORDED.** Four exports were read from the maintainer's
`~/Downloads`. §7.3 specifies the Pixel 10 Pro XL. The two profiles below differ by
**2.4× in inference cost**, which is large enough that they may not be the same
machine — so until the device is stated, **none of this counts as the §7.3
measurement.**

All runs use the **main-thread synchronous** configuration. Frames, detections and
percentiles are **windowed to the last 120 s** (`windowMs`); `timeline` in the export
covers the whole session.

| Export | Session | Frames (window) | Detections (window) | FPS p50 | FPS p05 | Inf Hz | Cost p50 | Cost p95 | Cost p99 | Cost max | Fallbacks | Stale |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0.0 s | 0 | 0 | — | — | — | — | — | — | — | 0 | 0 |
| 2 | 10.2 s | 955 | 115 | 120.5 | 59.9 | 11.4 | 20.2 | 27.0 | not recorded | not recorded | 0 | 0 |
| 3 | 116.9 s | 4810 | 643 | 120.5 | 59.9 | 12.7 | 20.7 | 28.7 | not recorded | not recorded | 0 | 0 |
| **4** | **824.8 s (13.7 min)** | **14240** | **2334** | **120.5** | **119.0** | **19.4** | **9.1** | **15.5** | **22.8** | **32.8** | **0** | **0** |

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

### Against the §7.3 decision rule

| # | Condition | Status |
|---|---|---|
| 1 | Worker improves render FPS and/or frame-time stability meaningfully | **Not supported.** Render p50 120.5 / p05 119.0 with variance ~1 ms² leaves essentially nothing to improve, and the cost tail is tight. |
| 2 | No control lag a human notices | **Machine side fine** (p99 22.8 ms, max 32.8 ms). The required **qualitative playtest rating is still missing**. |
| 3 | Acceptable reliability | **Promising.** 13.7 minutes continuous with zero fallbacks, zero stale frames, stable cost. Still needs the device confirmed and the timeline inspected. |
| 4 | A working main-thread fallback, implemented and tested | **Trivially satisfied** — main thread *is* the implementation. |

**Still no decision, now for the opposite reason.** §7.3 expects a worker to be
adopted only if it *improves* something measurable. On this evidence the main-thread
path already holds 120 fps with p05 119 and a tight cost tail, and the fallback clause
applies: *"stay on main thread, lower inference rate, and accept the render cost"* — which
the scheduler already does. What remains is confirming the device, reading the
timeline, and the human rating.

### What is still needed before a decision

1. **State the device.** Must be the Pixel 10 Pro XL, and the 2.4× cost difference
   between the run profiles needs explaining (same device warming up, or a different
   machine?).
2. **A 5-minute-plus run with the `timeline` present**, so degradation across the
   session is visible rather than assumed.
3. **The qualitative control-lag rating**: did the web gesture feel responsive,
   compared with the simulator?
4. **A run that includes hands leaving and returning**, so `framesWithNoHands` and the
   reacquisition path are covered by numbers.

## Where the numbers will be recorded

The measured session will be appended to this file, and the M1 acceptance row in
`docs/TEST_MATRIX.md` will move from `pending` to either *adopt worker* or *stay on
main thread*, each with the numbers that decided it.

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
