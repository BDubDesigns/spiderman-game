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

## Measured results — first device run (2026-10-12)

**Device: NOT RECORDED.** The numbers below came from exports in the maintainer's
`~/Downloads`. §7.3 specifies the Pixel 10 Pro XL, and the render rate is consistent
with a 120 Hz panel, but nobody has confirmed the device, so **this run cannot yet
count as the §7.3 measurement**. Confirm the device and re-run.

Three exports, all with the **main-thread synchronous** configuration:

| Session | Frames | Detections | render FPS p50 | render FPS p05 | Inference Hz | Cost p50 | Cost p95 | Fallbacks | Stale frames |
|---|---|---|---|---|---|---|---|---|---|
| 10.2 s | 955 | 115 | 120.5 | 59.9 | 11.4 | 20.2 ms | 27.0 ms | 0 | 0 |
| 15.6 s | 1482 | 197 | 120.5 | 59.9 | 12.7 | 20.7 ms | 28.7 ms | 0 | 0 |
| **116.9 s** | **4810** | **643** | **120.5** | **59.9** | **5.5** | **21.6 ms** | **29.6 ms** | **0** | **0** |

### What this establishes

- **Sustained render rate is not a problem.** p50 120.5 fps and p05 59.9 fps, *identical
  across all three sessions including the 117-second one*. §3's success criterion is
  ≥30 FPS sustained; this is 2–4× that, with no decay over two minutes.
- **Detection cost is stable.** p50 went 20.2 → 20.7 → 21.6 ms as sessions lengthened.
  No degradation, no warm-up cliff.
- **Zero fallbacks and zero stale frames across ~143 seconds cumulatively.** No camera
  teardown, no disabled detector, no held-then-stale hand. Relevant to the reported
  "crashing and killing the camera": **it did not recur in these runs.**
- **The adaptive scheduler is working.** The achieved rate fell from 12.7 Hz (15 s) to
  **5.5 Hz** (117 s) — it throttled itself down towards the `minInferenceHz` floor of 5
  as the cost estimate converged, exactly as §7.1 intends. Inference frequency is not a
  target, and the render rate was unaffected by the change.

### The tail is the interesting part, and it is only inferable so far

`detectionCostMs.variance` was **3911 ms²** against a mean of 23.9 ms. That is
arithmetically impossible for a tight distribution: it implies that roughly 1% of calls
took **hundreds of milliseconds**. The same run's frame times show the matching
signature — variance 553 ms² with p95 at 16.7 ms, implying ~1% of frames near 245 ms.

If real, that is the strongest argument *for* a worker that this project has produced:
the median call is comfortable, but occasional very slow calls block the main thread for
a visible fraction of a second, and §7.3 says stutter matters more than the mean.

**It is not yet evidence.** A tail inferred from a variance is a hypothesis, so
`Percentiles` now records **p99 and max** directly. The next export either confirms the
tail or kills it. Do not make a worker decision on the inference above.

### Against the §7.3 decision rule

| # | Condition | Status from these numbers |
|---|---|---|
| 1 | Worker improves render FPS and/or frame-time stability meaningfully | **Plausible but unproven.** Render FPS is already 120/60, so a worker cannot improve the median. It could improve the *tail*, which is where the variance lives — pending p99/max. |
| 2 | No control lag that a human notices | **Measurement incomplete.** The machine side looks fine (p95 29.6 ms). The required qualitative playtest rating has not been given. |
| 3 | Acceptable reliability | **Promising, not sufficient.** 117 s clean is a good sign but §7.3 and §17 ask for 5 minutes. Thermals beyond 2 minutes are unmeasured. |
| 4 | A working main-thread fallback, implemented and tested | **Satisfied trivially today**, because main thread *is* the implementation. Adopting a worker means this stops being free. |

**No decision.** On the median numbers, main thread looks comfortable and §7.3's own
fallback clause applies — "stay on main thread, lower inference rate, and accept the
render cost" — which is precisely what the scheduler already did (12.7 → 5.5 Hz). The
open question is the tail, and the next export answers it.

### What is still needed before a decision

1. **Confirm the device** (must be the Pixel 10 Pro XL).
2. **A 5-minute continuous session**, ending with the export — for the §17 reliability
   window and to see whether the tail or the thermals change.
3. **The qualitative control-lag rating**, which no harness can capture: did the web
   gesture feel responsive, compared with the simulator?
4. **The p99/max columns** from a run on this build, to confirm or refute the inferred
   tail.

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
