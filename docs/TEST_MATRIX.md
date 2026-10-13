# TEST_MATRIX.md

Every acceptance test from PLAN.md §13, with its classification and status.

- **[A]** agent-testable
- **[H]** human/device required
- **[A+H]** both required

**A milestone is not fully accepted until all of its `[H]` rows are checked by a
human** (PLAN.md §14.3, §16.5). An agent updates `[A]` rows only. If a required
device or hand test is unavailable, the row is marked `pending` and explicit human
approval is required before starting the next milestone. **Pending is never
reported as passed.**

Status key: `[x]` verified · `[ ]` not started · `pending` awaiting human

**Current state: M0 — ACCEPTED (all `[A]` rows verified, plus human visual
confirmation). M1 — agent-complete, PENDING HUMAN DEVICE VERIFICATION: all four
`[H]` rows are outstanding, so M1 is not accepted. M2 — implemented provisionally
under explicit maintainer authorisation; both `[A]` rows verified, all five `[H]`
rows outstanding, so M2 is not accepted either. M3 — implemented provisionally;
its `[A]` row is verified, its `[H]` row is outstanding, so M3 is not accepted.
M4 — implemented provisionally; its `[A]` row is verified, its `[H]` row is
outstanding, so M4 is not accepted.**

Provisional M2/M3/M4 development was authorised by the maintainer while M1's `[H]`
rows remain pending. That authorisation covers **development only**: no `[H]` row is
ticked, no milestone is declared accepted, and M1 still gates real use.

Status key: `[x]` verified · `[ ]` not started · `pending` awaiting human

---

## M0 — Dev harness, replay, and interactive mouse/touch hand simulator

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M0.1 | `npm run dev` shows synthetic landmarks animating on screen, driven by the mouse or a replay file | [A] | [x] | Automated: `src/pipeline.test.ts` drives the real fixed-step loop, pulls frames from `MouseSource` and `ReplaySource`, and asserts 21 dots drawn per hand per frame (20 frames → 420 dots) at the transformed positions. Dev server smoke-checked (every module 200, fixture transforms). **Human visual verification recorded 2026-10-12:** the maintainer ran the harness and confirmed the landmarks animate under both the mouse simulator and the replay fixture, closing the residual visual question. |
| M0.2 | No camera involved. No game systems yet | [A] | [x] | No `getUserMedia`, no MediaPipe dependency, no camera import anywhere. `package.json` has no runtime dependencies at all. No targets/webs/scoring modules exist; `src/game/loop.ts`'s `update` is intentionally empty. |
| M0.3 | Unit tests exist for the coordinate transform `toCanvas` and pass | [A] | [x] | `src/render/stage.test.ts` — 21 tests covering origin, horizontal mirror, edge values, non-square aspect ratios and the Rule E inverse. Whole suite: **105/105 passing** across 7 files. |

Additional M0 verification beyond the stated criteria:

| Check | Class | Status | Evidence |
|---|---|---|---|
| TypeScript strict mode clean | [A] | [x] | `npm run typecheck` → 0 errors, with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `verbatimModuleSyntax`. |
| Production build succeeds | [A] | [x] | `npm run build` → 13 modules, 25.66 kB JS (9.56 kB gzip), 0.84 kB CSS. |
| No known dependency vulnerabilities | [A] | [x] | `npm audit` → 0 vulnerabilities (Vite 7.3.7, Vitest 5.0.4, TypeScript 5.9.3, all exactly pinned). |
| ESLint (type-aware) clean | [A] | [x] | `npm run lint` → 0 problems with `--max-warnings=0`, using `typescript-eslint`'s `recommendedTypeChecked`. Found one real defect, since fixed: method-syntax callbacks in `FixedStepLoopOptions` implying an absent `this`. |
| CI green on all supported Node versions | [A] | [x] | GitHub Actions run 38285663648: lint/typecheck/test/build pass on Node 22, 24 and 26. |
| Mirroring round-trips exactly once | [A] | [x] | `src/pipeline.test.ts` asserts a pointer at a deliberately off-centre canvas point produces a palm centroid at that same point, i.e. canvas → normalized → hand → canvas is the identity. |
| Replay fixture is well-formed and honest about being synthetic | [A] | [x] | `src/sim/replaySource.test.ts` parses the committed fixture and asserts 24 complete hands, no per-hand confidence fields, `provenance: "simulated"`, and that the middle/ring fingers actually fold mid-clip. |
| The HUD reports no unmeasurable value | [A] | [x] | `src/debug/hud.test.ts` asserts the HUD text contains no `Hz`, `inference`, `confidence`, `gestureScore`, `latency` or `staleness` string (PLAN.md §5.1, §6.2, §7.2). |

---

## M1 — Camera, real tracking, identity, and the worker decision

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M1.1 | Mirrored video and landmarks both align with the real hands on screen; HUD text reads correctly (unmirrored) | [H] | pending | **Full-pipeline gate (PLAN.md §8 Rule F). Nothing may proceed past a failure here.** Procedure: `docs/M1_DEVICE_TESTS.md` §1. Requires the Pixel 10 Pro XL and HTTPS (a plain-HTTP LAN URL is not a secure context, so the camera cannot start — that would be a different result, not a pass). |
| M1.2 | Handedness label verified empirically and corrected if needed | [H] | pending | Procedure: `docs/M1_DEVICE_TESTS.md` §2. `MEDIAPIPE.swapHandedness` is `false` (unverified, no swap). The HUD's `handedness conflicts` counter is the signal. `[A]` support: `handTracker.test.ts` asserts the swap is applied in exactly one place and that an inverted label does not drop hands mid-crossing. |
| M1.3 | Identity association survives a hand crossing and a hand leaving/re-entering frame without swapping | [H] | pending | Procedure: `docs/M1_DEVICE_TESTS.md` §3. `[A]` support below (M1.6) covers the same invariants against synthetic sequences; this row is the real-hand confirmation. |
| M1.4 | Camera denied → simulator offered and usable, no dead end | [H] | pending | Procedure: `docs/M1_DEVICE_TESTS.md` §4, four separate denial paths. `[A]` support: `camera.test.ts` covers the failure taxonomy, and every path in `main.ts` routes to the simulator. |
| M1.5 | Worker decision recorded in `docs/` with measured numbers | [A] | [x] | **DECIDED: adopt the worker**, on the §7.3 A/B in `docs/M1_WORKER_DECISION.md`. Main thread: p05 **59.5 fps** and **1115.4 ms** of Chrome-reported blocking in a single `requestVideoFrameCallback` (one detection took 1161.8 ms against a 21.7 ms median — the GPU delegate's first-inference warm-up). Worker: p05 **119.05 fps**, **0 ms** blocking, for a +3.8 ms p50 / +9.8 ms p99 round trip doing identical work, with no CPU fallback. `DETECTION_MODE` defaults to `'worker'`; `?inference=main-thread` is the tested fallback. §7.3 criterion 2 (human latency rating) is still outstanding, which is why the machine-side decision is recorded as decided while acceptance is not. |
| M1.6 | Identity association unit tests pass against recorded landmark sequences | [A] | [x] | `src/tracking/handIdentity.test.ts` — 18 tests, including a computed two-hand crossing that swaps sides, absence shorter than the grace window (held, marked stale) versus longer (lost, render stopped, reacquisition timestamped), and a positional jump that contradicts handedness. Plus `src/sim/fixtureGenerators.test.ts` — 10 tests, which pin the two committed sequences `fixtures/identity-crossing.json` (24 frames, palms reach 0.019 apart at the crossing) and `fixtures/identity-reacquire.json` (32 frames; absences of 834 ms and 125 ms against a 600 ms grace window). |

Additional M1 verification beyond the stated criteria:

| Check | Class | Status | Evidence |
|---|---|---|---|
| MediaPipe pinned exactly, assets self-hosted, no CDN at runtime | [A] | [x] | `@mediapipe/tasks-vision` at exactly `1.1.0`. WASM copied from that same pinned package by `npm run assets:sync` (idempotent; skips identical files). The `.task` model is committed with its checksum pinned to Google's published ETag (`15318430ea3851670fe9914116a9cfad`), re-verifiable with `node scripts/fetch-hand-model.mjs --verify-only`. `npm run build` emits `dist/wasm/` (4 files) and `dist/models/`, and the bundle contains **zero** CDN references. |
| Adaptation to the real library, not to a tutorial | [A] | [x] | `handTracker.test.ts` constructs a genuine `HandLandmarkerResult` and asserts the project's structural type accepts it, so a field rename in MediaPipe fails the build instead of silently yielding zero hands at runtime. |
| Adaptive scheduling, decoupled from rendering | [A] | [x] | `inferenceScheduler.test.ts` — 13 tests covering the `maxInferenceHz` rate cap, the budget skip driven by measured cost, the `minInferenceHz` floor overriding the budget, recovery when calls get cheaper, and the frame-budget basis tracking observed frame intervals. |
| Mirrored video pass releases its transform | [A] | [x] | `drawVideo.test.ts` — 6 tests: the flip is `(-1, 0, 0, 1, cw, 0)`, the draw covers the full canvas, and `save`/`restore` are balanced so the HUD cannot inherit the mirror. |
| Camera failure taxonomy is actionable, not a generic error | [A] | [x] | `camera.test.ts` — 26 tests mapping each DOMException name to a distinct reason and player-facing message, plus unsupported/insecure-context, metadata timeout, play rejection, and track teardown. |
| HUD reports only measured values | [A] | [x] | `hud.test.ts` — 12 tests. Measured inference must be labelled `Hz (measured)`; the word "confidence" must never appear; `identityMatchScore` must never be presented as a model output; the interpolated-frame count must be stated. |
| Worker configuration exists behind the same seam, and cannot regress the default | [A] | [x] | Both detectors satisfy `DetectionBackend`, so switching is `?inference=worker`. Default is `main-thread`, so an unproven path is inert. `inferenceWorkerCore.test.ts` (17 tests) covers protocol validation, the GPU → CPU fallback, bitmap release on **every** path including throw and unready, handedness swapping, and close; `workerBackend.test.ts` (14 tests) covers the init handshake, fallback reporting, init and detect timeouts, out-of-order result correlation by id, a capture failure, and teardown rejecting pending work. A real bug was found by those tests: `close()` during the asynchronous capture window left a detection in flight and would have posted to a terminated worker. |
| MediaPipe's WASM factory loads in **both** worker types, so dev and prod behave alike | [A] | [x] | Reproduced failure: Vite's dev server always serves the worker as `type: "module"` (`worker.format` is build-only), MediaPipe's `importScripts` throws, its `import()` fallback makes Vite serve a `public/` file as a module, and Vite refuses. Measured directly: a classic request for `/wasm/vision_wasm_internal.js` returns 200 / 335 KB, a module request returns the error. Fixed by `wasmFactory.ts`, which makes the factory global itself and clears `wasmLoaderPath` so the library's loader is skipped. `wasmFactory.test.ts` (11 tests) covers the classic path, the module-worker fallback, no-`importScripts`, idempotence, HTTP failure, a script that defines nothing, and the preserved `importScripts` error. |
| The worker build is a classic script, and needs no configuration to be one | [A] | [x] | `dist/assets/inferenceWorker-*.js` begins `(function(){"use strict"` with `importScripts` present. Verified with `vite.config.ts` **deleted**: identical output, because `worker.format` already defaults to `'iife'`. The file was a no-op and has been removed. |
| No regression in the M0 harness | [A] | [x] | All M0 tests still pass unchanged (105 before M1, 210 after), including the pointer → normalized → hand → canvas mirroring round-trip. |

## M2 — Gesture detection and tuning

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M2.1 | Unit tests for `classifyGesture` against a fixture set covering folded/extended/ambiguous poses | [A] | [x] | `classifyGesture.test.ts` — 16 tests. Folded (gesture), open hand, fist, and a half-folded pose (index/pinky out, ring still out) that must **not** fire. Hysteresis is asserted from both directions: a measure in the `foldEnter`–`foldExit` band counts as folded only when coming from folded, and one in the `extExit`–`extEnter` band stays extended only when coming from extended. Also covers §11.1 span normalization (an adult and a 0.6-scale child hand classify identically), an incomplete hand and a zero span returning `null` rather than a misleading pose, and `gestureScore` being the weakest of the four conditions. |
| M2.2 | Unit tests for the state machine: release-to-rearm, no-fire-while-held, rearm-block-on-reacquisition | [A] | [x] | `gestureStateMachine.test.ts` — 16 tests, plus `gestureController.test.ts` — 10 tests through the real smoothing and classifier. The §11.7 invariant is asserted directly: **20 seconds of continuously holding the pose fires exactly once**. Two deliberate pose-release cycles fire exactly twice; three and five cycles likewise. Releasing and re-posing inside `COOLDOWN_MS` does not fire. §11.8: a reacquired hand cannot fire however long it holds, arming only after `REARM_MS` of *continuous* release, and the release window restarts if the pose reappears mid-block. A stale hand **freezes** rather than advancing, so frozen data cannot satisfy `HOLD_MS`. |
| M2.3 | Gesture fires reliably when performed deliberately by an **adult** hand | [H] | [ ] | **Outstanding — needs a real adult hand.** Not verifiable from the development environment. |
| M2.4 | Gesture fires reliably by a **child's** hand (if the child is unavailable this is recorded as deferred and the milestone is **not** fully accepted) | [H] | [ ] | **Outstanding.** Availability to be confirmed by the human. Even if the child is unavailable, M2 cannot be accepted without M2.3, M2.5 and M2.6. |
| M2.5 | Ordinary hand movement does **not** fire | [H] | [ ] | **Outstanding.** Unit tests show an open hand scores 0 and never arms, and that a full simulation of normal movement fires nothing, but §11.2 is explicit that the thresholds are unvalidated guesses and only a real hand can settle this. |
| M2.6 | Gesture tested at the five orientations in §11.5; failures documented | [H] | [ ] | **Outstanding.** The five orientations (palm to camera, palm away, edge-on, tilted forward, tilted back) have not been tested — the classifier's distance check assumes a curled tip is near the palm regardless of orientation, and that assumption is exactly what this row exists to falsify. |
| M2.7 | Tuned thresholds committed to `config.ts` with a comment recording device and hand used | [A+H] | [ ] | **Outstanding.** `GESTURE` in `config.ts` carries the §11.2 starting guesses and says so: *"These thresholds are initial guesses from §11.2 and are NOT validated values."* They must not be marked tuned until a real hand on the Pixel 10 Pro XL has settled them. |

## M3 — Webs and targets

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M3.1 | Hit detection and target state unit tests pass | [A] | [x] | `targets.test.ts` (13), `autoAim.test.ts` (12), `webs.test.ts` (14), `gameState.test.ts` (9), `drawWebs.test.ts` (16) — 64 tests. Target state: deterministic seeded spawning, on-screen bounds, a real separation floor, id uniqueness, `active`/`webbed` transitions, and that an already-webbed target **cannot** be consumed twice. Hit detection: radius as a fraction of the shorter side, so a target covers the same visual area at any resolution. Auto-aim: nearest-in-cone wins over a nearer target behind the hand, falls back to nearest when nothing is in the cone, ignores webbed targets, and Model B behind the flag. Webs: Bézier sag proportional to distance, monotone travel, tip pinned to the impact point through the splat, and a miss resolving as an ordinary outcome. Integration: **the simulator webs a target after a pose-hold-release cycle**, clears the whole field for seeds 1–8 with zero misses, and a fully-webbed field produces a recorded miss rather than an error. |
| M3.2 | On the primary device, performing the gesture at a target produces a correct-looking web originating from the hand and splatting on the target | [H] | [ ] | **Outstanding — needs the device and a real hand.** The renderer is verified structurally (the correct primitives at the correct mirrored positions, splat rays only after landing, canvas state restored) but *not* visually: whether a web looks like a web is a human judgement. The in-app WebView was backgrounded for this run, so `requestAnimationFrame` never fired and the canvas never painted; see `docs/android-development.md`. |

## M4 — Full round

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M4.1 | Scoring and alternation state machine unit tests pass, including the wrong-hand no-op rule (§12.4) | [A] | [x] | `round.test.ts` (15) plus `gameState.test.ts` (12). Each of §12.4's five prohibitions has its own test: a wrong-hand fire returns feedback but does **not** score, does **not** consume or web a target (the gate runs before `TargetField.web()` is ever called, so it is structurally impossible), does **not** change `lastScoringHand`, and does **not** change the required next hand. Spamming the wrong hand 50× scores nothing. Alternation is proven in both directions (right→left→right and left→right→left), either hand may open the round so a child is never told they started wrong, and a miss from the correct hand does not consume the turn. Integration: a **complete round is won by alternating hands in the simulator** (`?source=mouse`, `H` to switch), winnable for **every seed 1–8**, holding the pose continuously scores exactly once, and `R`/`respawn()` restores a fresh round with the opening freedom back. |
| M4.2 | A complete playable round start to finish on the primary device | [H] | [ ] | **Outstanding — needs the device and a real hand.** The round logic is verified end to end through the simulator, and the win screen and next-hand HUD are drawn, but no round has been played on the Pixel 10 Pro XL, and the visuals are unverified: the in-app WebView was backgrounded for this run, so `requestAnimationFrame` never fired and the canvas never painted. |

## M5 — Polish

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M5.1 | Runs at ≥30 FPS sustained on the Pixel 10 Pro XL at the chosen quality tier; feels good in playtest | [H] | [ ] | M5 work. |

## M6 — Hardening and cross-browser

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M6.1 | Every failure path produces a clear message and a playable alternative where possible | [H] | [ ] | M6 work. |

---

## Manual checklist coverage (PLAN.md §17)

The §17 manual checklist applies from M1 onward. Every item on it is `[H]`, so
none can be checked at M0. Items that M0 does *not* touch at all — camera,
handedness label, crossings, gesture firing, scoring, round completion, device
rotation on real video, 5-minute device play — are deliberately left for the
milestones that introduce the relevant subsystem.
