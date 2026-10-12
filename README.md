# Web Slinger

[![CI](https://github.com/BDubDesigns/spiderman-game/actions/workflows/ci.yml/badge.svg)](https://github.com/BDubDesigns/spiderman-game/actions/workflows/ci.yml)

A standalone browser game where a player uses their **real hands**, tracked
through the webcam, to sling webs like Spider-Man.

The player performs the web gesture — middle and ring fingertips pressed to the
palm, index and pinky extended — and a web fires from the on-screen position of
their **actual hand** to a target. Hands must alternate. It runs on a Pixel 10 Pro
XL in Chrome as the primary device, with a desktop browser as secondary. All
processing happens on-device. There is no backend.

The primary audience is a young child, so the design goal is delight and
forgiveness rather than difficulty.

> **Product name: Web Slinger.** Do not rename it.

The authoritative specification is [`PLAN.md`](PLAN.md). Where this README and the
plan disagree, the plan wins.

---

## Status

| Milestone | State |
|---|---|
| **M0** — dev harness, replay, interactive mouse/touch hand simulator | **Accepted** — agent-testable criteria pass, and the human visually confirmed the harness on 2026-10-12 |
| **M1** — camera, real tracking, identity, worker decision | **Agent-complete, pending human device verification** — see `docs/TEST_MATRIX.md` and `docs/M1_DEVICE_TESTS.md` |

M0 has no `[H]` (human/device) acceptance criteria, so it was acceptable on
agent-testable evidence alone. The human additionally ran the harness and
confirmed the landmarks animate under the mouse and replay, so the one residual
visual question is now closed rather than assumed.

M1 has four `[H]` rows — mirrored-video alignment, the handedness label, real-hand
crossing/reacquisition, and camera-denial fallback. **All four are outstanding, so
M1 is not accepted and M2 has not started.** The exact procedures are in
[`docs/M1_DEVICE_TESTS.md`](docs/M1_DEVICE_TESTS.md); the worker decision is
deferred with its rationale and measurement plan in
[`docs/M1_WORKER_DECISION.md`](docs/M1_WORKER_DECISION.md).

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 210 tests, 13 files
npm run lint       # ESLint, type-aware, zero warnings allowed
npm run typecheck  # tsc --noEmit, strict
npm run build      # typecheck + production bundle
```

Node **^22.12 || ^24 || >=26** is required (pinned in `engines`; Vitest 5 needs
it). Dependencies are exactly pinned — no `^`, no `~`. There is exactly **one
runtime dependency**: `@mediapipe/tasks-vision` at `1.1.0`, which ships in the
bundle. Everything else is build or test tooling, and `npm run build` runs
`assets:sync` first.

## Linting

`npm run lint` runs ESLint over `src/`, using the **type-aware**
`typescript-eslint` rules rather than syntax-only ones. The interesting bugs in
this codebase are type-shaped — a floating promise in the render loop, an
`unknown` narrowed by assertion instead of by a guard, a cast hiding a real type
change — and rules that only see syntax cannot detect those. The parser is
pointed at the same `tsconfig.json` the build and Vitest use, so lint cannot
disagree with `tsc` about what the project is.

`--max-warnings=0` is set, so a warning fails just like an error, locally and in
CI. `npm run lint:fix` applies the auto-fixable subset.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull
request, and gates four things:

| Step | Command |
|---|---|
| Lint (type-aware) | `npm run lint` |
| Strict typecheck | `npm run typecheck` |
| Unit tests | `npm test` |
| Production build | `npm run build` |

It installs with `npm ci`, so the committed lockfile is authoritative: a drift
between `package.json` and `package-lock.json` fails the build instead of
silently resolving different versions than a developer has.

The job runs across **Node 22, 24 and 26** — exactly the range
`package.json#engines` claims to support — with `fail-fast: false`, so a single
run reports the whole compatibility picture rather than stopping at the first
failure. The npm download cache is cached, and superseded runs on the same ref
are cancelled.

`GITHUB_TOKEN` is scoped to `contents: read`. This project has no backend, no
telemetry, no secrets and no deploy step, so nothing broader is needed — and
nothing broader should be granted.

Deliberately **not** in CI: an `npm audit` gate, because advisory churn produces
spurious red builds on unrelated pull requests. `npm audit` is run by hand
instead and is currently clean.

`PLAN.md` does not specify CI or a linter. Both are here because every acceptance
test in §13 is only meaningful if it actually runs on every change, and because
M1 onward introduces camera- and device-dependent behavior that benefits from a
fixed baseline.

## What M0 is

A development harness. It proves the render loop and the coordinate transform
work before any camera or gameplay is involved:

- Vite + TypeScript in strict mode.
- A canvas sized to a placeholder 640×480 "source" (`PLAN.md` §8 Rule A).
- A fixed-timestep update loop decoupled from rendering.
- Two interchangeable hand-data sources behind one interface.
- A dot drawn at every landmark through the single `toCanvas()` transform.

### Harness controls

| Input | Effect |
|---|---|
| Move the mouse / drag a finger | Moves the synthetic hand; the palm follows the pointer |
| Press and hold | Folds the middle and ring fingers into the web-gesture pose |
| **Start camera** button | Start the camera and hand tracking. A real button, so the permission prompt and any playback retry follow a genuine user activation; it becomes **Resume video** if the browser refuses playback while the stream is still live |
| <kbd>C</kbd> | Same as the button, from the keyboard |
| <kbd>X</kbd> | Stop the camera and release the stream |
| <kbd>1</kbd> | Mouse/touch simulator source |
| <kbd>2</kbd> | JSON replay fixture source |
| <kbd>H</kbd> | Toggle the simulated hand between right and left |
| <kbd>M</kbd> | Toggle the source-space corner markers |
| <kbd>E</kbd> | Download the §7.3 measurement report (see the worker decision doc) |
| `?source=camera` / `?source=replay` / `?source=mouse` | Choose the starting source from the URL |

The corner marker is a deliberate visual assertion: it is labelled `video (0,0)`
and **must appear on the right**, because `toCanvas()` mirrors x. If it appears on
the left, something has flipped twice.

## What M0 is not

Binding scope fences (`PLAN.md` §2). Out of scope for v1; do not build without an
explicit plan revision:

- ❌ Rigged 3D Spider-Man avatar or pose retargeting
- ❌ Full-body pose tracking (hands only)
- ❌ Multiplayer, networking, accounts, cloud persistence
- ❌ Server-side anything — no backend, no runtime API calls, no telemetry
- ❌ A 3D rendering engine (Three.js, Babylon, …)
- ❌ Level editor, asset pipeline, CMS
- ❌ Monetization, ads, analytics
- ❌ Service worker / true offline support (see below)
- ❌ Custom telemetry infrastructure

At M0 specifically, there is also **no MediaPipe integration, no camera access,
and no game systems** — targets, webs and scoring arrive in M3/M4.

## Runtime assets and offline behavior

Two things are often conflated here, and the distinction is deliberate
(`PLAN.md` §9):

- **Self-hosted runtime dependencies** — the MediaPipe WASM bundle and the
  `.task` model, served from the same origin as the app. **This is required.**
  Both now exist; see the asset pipeline below. No CDN at runtime.
- **True offline support** — the app loads and runs with no network at all,
  including after a first visit. This needs a **service worker**.

**v1 decision: self-host all runtime assets, and do not add a service worker.**
Rationale:

- The game needs a camera and a person in front of it. It is not a "use it on a
  plane" app, so offline is not a requirement.
- A service worker adds real maintenance surface: cache versioning, an update
  flow, cache invalidation, and stale-build bugs that are painful to debug.
- Offline play is not among the success criteria in `PLAN.md` §3.

If a service worker is ever added, it should be an explicit, isolated change with
its own tests, not a drive-by addition.

*At M0 this is prospective:* there are no runtime assets to self-host yet,
### The asset pipeline

`@mediapipe/tasks-vision` is pinned to exactly `1.1.0`. Its WASM bundle is copied
out of that same pinned package into `public/wasm/` by `npm run assets:sync`,
which `dev` and `build` run automatically. The copy is idempotent (identical files
are skipped) and cannot drift from the installed version, because it *is* the
installed version. `public/wasm/` is git-ignored for that reason — it is derived,
not source.

The `.task` model is **not** published on npm, so it is committed at
`public/models/hand_landmarker.task` (7.46 MB) and a fresh clone runs without a
network fetch. Its checksum is pinned to Google's own published ETag for the
object, so `node scripts/fetch-hand-model.mjs --verify-only` proves the committed
bytes are the revision this code was written against.

Why `public/` and not a bundler import: MediaPipe assembles the WASM filenames at
runtime from a template literal, so Vite's static analysis cannot see them. They
are not bundled, hashed or copied automatically, and there is no warning — a build
without this step 404s on the first inference. Verified against the pinned version.

For deployment, serve `.wasm` as `application/wasm` and enable compression: the
SIMD and non-SIMD binaries are 12–13 MB each and gzip roughly 3–4×.

## Project structure

```
src/
  main.ts                 bootstrap, wiring, top-level state
  config.ts               ALL tunable constants (PLAN.md §19.2)
  platform/
    camera.ts             getUserMedia, video element, permission-failure taxonomy
    raf.ts                requestVideoFrameCallback clock with rAF fallback
    ...                   (M5) audio; (M6) orientation extras
  tracking/
    landmarkTypes.ts      our own landmark/handedness/frame types + source contract
    handTracker.ts        HandLandmarker adapter + CameraHandSource
    inferenceScheduler.ts adaptive inference budget (§7.1)
    handIdentity.ts       stable left/right identity (§10)
    ...                   (M2) smoothing, gesture, hand state
  sim/
    mouseSource.ts        interactive synthetic 21-landmark hand
    replaySource.ts       JSON landmark replay + fixture validation
  game/
    loop.ts               fixed-timestep update, decoupled from render
    ...                   (M3/M4) targets, scoring, rounds
  render/
    stage.ts              canvas sizing + THE coordinate transform
    drawVideo.ts          mirrored camera pass, transform released on exit
    drawHands.ts          debug landmark dots
    ...                   (M3/M5) drawWeb, drawHud, fx
  debug/
    hud.ts                measured render/inference figures only
    measurement.ts        on-device §7.3 metrics recorder and JSON export
fixtures/
  replay-sweep.json       24-frame synthetic clip
  identity-crossing.json  two hands that swap sides (24 frames)
  identity-reacquire.json absence past and within the grace window (32 frames)
scripts/
  sync-mediapipe-assets.mjs  copy the WASM bundle out of the pinned package
  fetch-hand-model.mjs       fetch/verify the .task model by checksum
public/
  models/hand_landmarker.task  committed
  wasm/                        generated by assets:sync, git-ignored
docs/
  COST_LOG.md             per-milestone agentic cost record (PLAN.md §14)
  TEST_MATRIX.md          every §13 acceptance test, [A] vs [H]
  M1_WORKER_DECISION.md   the §7.3 decision: deferred, with the procedure
  M1_DEVICE_TESTS.md      exact device procedures for the human
```

## The one coordinate rule

`PLAN.md` §8 calls this the #1 bug source, so it has exactly one implementation:

```ts
// src/render/stage.ts — THE ONLY place normalized video space becomes canvas space
function toCanvas(lm, cw, ch) {
  return { x: (1 - lm.x) * cw, y: lm.y * ch };  // 1 - x == horizontal mirror
}
```

- Mirroring is done **in code, once**, never with CSS `scaleX(-1)` — a CSS flip
  would also mirror HUD text and any DOM UI above the canvas.
- The canvas **never** carries a mirror transform at M0, because there is no
  video image yet. M1 adds the mirrored video pass via
  `setTransform(-1, 0, 0, 1, cw, 0)` and **must clear it before drawing the HUD**.
- `toNormalized()` is the exact inverse, permitted only where a subsystem
  genuinely needs normalized space (`PLAN.md` §8 Rule E). The simulator is the
  M0 case: the pointer arrives in canvas space, is inverted to normalized space,
  and is converted back by the renderer — so a hand appearing under the cursor is
  evidence the transform round-trips.
- Canvas dimensions are re-synced on resize/orientation change and never cached
  (Rule D).

## Model outputs vs. computed heuristics

`PLAN.md` §5.1 and §6.2 draw a hard line, enforced in code:

**Model outputs, the only two we consume** — `landmarks` (21 normalized points per
hand) and a handedness classification `{ label, score }`.

**Not model outputs** — hand detection, presence and tracking confidence. The
`minHandDetectionConfidence` / `minHandPresenceConfidence` / `minTrackingConfidence`
options are *configuration inputs*. There are therefore no
`apiDetectionConfidence`-style fields in this codebase, and none may be added.

Anything else — `gestureScore`, `identityMatchScore`, `staleness` — is a
**game-computed heuristic** and must be named so. It must never appear in the HUD
or logs as a confidence. `src/debug/hud.test.ts` asserts the HUD cannot regress
into displaying one.

## Testing

210 tests across 13 files cover the coordinate transform, the fixed-timestep
policy, the simulator geometry, fixture parsing and the replay source, rendering,
the mirrored video pass, the camera failure taxonomy, the inference scheduler,
result mapping and the delegate fallback, hand identity association, the HUD text,
and the pipeline end to end. Rendering is tested with a recording stub rather than
a browser, so the suite runs anywhere with no DOM.

Two tests exist to catch library churn rather than logic errors: one constructs a
genuine MediaPipe `HandLandmarkerResult`, so a field rename fails the build instead
of silently yielding zero hands at runtime, and the fixture tests assert the
committed sequences still deep-equal what their generators produce, so editing a
generator without regenerating fails.

`fixtures/replay-sweep.json` is generated by the same `buildSyntheticHand`
geometry the simulator uses, so it stays geometrically consistent with the
simulator. It is marked `"provenance": "simulated"` and must never claim
`"observed"`; recordings from a real camera in M1 must say `"observed"`.

Every acceptance test in `PLAN.md` §13 is classified and tracked in
[`docs/TEST_MATRIX.md`](docs/TEST_MATRIX.md). `[H]` rows need a human; a
milestone is not fully accepted until they are checked.

## Experiment note

This project doubles as a real, unsubsidized measurement of agentic development
cost using DeepSeek Harness, recorded per milestone in
[`docs/COST_LOG.md`](docs/COST_LOG.md). The measurement is deliberately
lightweight: one row per milestone, using only what DSH already exposes. There is
no telemetry in the game, no collector, and no dashboard.

## Divergences from the plan's sketch

Recorded for review, since `PLAN.md` §6 is a structural sketch rather than a
contract:

1. **`HandFrameSource` lives in `tracking/landmarkTypes.ts`** rather than in a new
   file, to keep the file list close to §6. It is the shared contract that
   `sim/`, the M1 camera tracker and the game loop all satisfy.
2. **`src/debug/hud.ts` exists at M0**, as a minimal early slice of the M2 debug
   HUD. It reports render FPS, source and draw counts only. It deliberately shows
   no inference Hz, latency, gesture score or per-hand state, because none of
   those are measured yet (`PLAN.md` §7.2).
3. **The fixture is imported as a bundled JSON module, not fetched.** This keeps
   `sim/` free of I/O, and means no 404/CORS failure mode in dev. Large M1
   recordings should move to `public/` and be fetched instead.
4. **No `vite.config.ts`.** Vite and Vitest defaults cover everything M0 needs;
   adding configuration that does nothing would be noise.
5. **Vitest is pinned at 5.0.4, not 3.x.** Vitest ≤ 4.1.10 depends on a `tinypool`
   with a critical advisory. Bumping to 5.0.4 takes `npm audit` to zero
   vulnerabilities; the test code uses only the stable `describe`/`it`/`expect`
   API, so the major bump cost nothing.
6. **Tests beyond the required `stage.test.ts`** were added for the loop,
   simulator, replay parser, renderer, HUD and the end-to-end pipeline, per
   `PLAN.md` §16.3 ("every non-trivial subsystem has fixtures, unit tests, and
   documented edge-case behavior").
7. **ESLint was added at the maintainer's request**, which `PLAN.md` does not call
   for and which is therefore a deliberate exception to §16.2 ("do not add
   dependencies for convenience"). It is dev-only tooling and adds nothing to the
   shipped bundle. It immediately found one real defect: two callbacks declared
   with method syntax in `FixedStepLoopOptions`, which implied a `this` the loop
   never provides and would have broken if invoked detached.
8. **`tracking/inferenceScheduler.ts` is its own module**, rather than the
   scheduling logic living inside `handTracker.ts` as §6 implies. The budget policy
   is the part of §7.1 most worth testing, and keeping it clock-free and pure makes
   all three of its bounds (rate cap, budget, floor) unit-testable without a
   camera.
9. **`debug/measurement.ts` was added**, which §6 does not list. §7.3 makes the
   worker decision a measurement question, so something has to collect the numbers
   on the device. It is a bounded rolling-window recorder with an explicit export,
   not telemetry — §14.2 forbids building measurement infrastructure, and nothing
   leaves the device.
10. **The WASM bundle is copied out of the pinned package instead of being
    committed**, and `public/wasm/` is git-ignored. §9 says to download the assets
    into `public/`, which this does; committing a second copy of ~26 MB that ships
    inside the pinned npm package would add nothing but a drift risk. The `.task`
    model, which is not on npm, *is* committed.
11. **`DetectionOutcome` returns the observations**, so identity association runs
    once per detection rather than once per rendered frame. Running it per frame
    would re-observe the same hands repeatedly and make the grace and staleness
    windows meaningless.
