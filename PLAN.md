# PLAN.md — Web Slinger: Camera-Controlled Web-Slinging Game

**Revised implementation plan for handoff to DeepSeek Harness (DSH).**

---

## Changelog (material revisions)

### v3 revisions (this document)

1. **Primary device changed.** The primary target is now the **maintainer's laptop
   running desktop Chrome**, not the Pixel 10 Pro XL. This is a decision by the human
   owner on 2026-10-12: the game will mostly be played on that laptop, and testing on
   the phone is impractically slow, so optimising and validating for the phone first
   was costing time for a target that is not the one that matters.
2. **The Pixel becomes a secondary, non-blocking target.** Everywhere this plan says
   "on the Pixel 10 Pro XL", read **"on the primary device"**. That covers §3, §7.1,
   §7.3, M5 and the §17 checklist. Mobile-specific hardening stays in scope as a
   secondary target — `playsinline`, iOS autoplay quirks, mobile thermals — and M6
   remains the cross-browser pass, but **no milestone is gated on the phone.**
3. **All measurements taken so far already satisfy this.** The four device sessions
   in `docs/M1_WORKER_DECISION.md` were all recorded on that laptop, which the human
   owner has now confirmed, so they count towards §7.3. The 2.4× spread in inference
   cost between sessions is therefore **not** a device difference and must be
   explained some other way (capture resolution and machine load are the leading
   candidates; the harness now records the negotiated capture size).
4. **§4.2's prior ToyStage evidence is historical** and stays as written: it was
   measured on the Pixel, and it is retained only to establish that assuming a fixed
   inference rate is unsafe. It is not a benchmark of the primary device.

### v2 revisions (this document)

1. **MediaPipe API outputs corrected.** Removed fabricated per-hand `apiDetectionConfidence`, `apiPresenceConfidence`, and `apiTrackingConfidence` fields. The JS `HandLandmarkerResult` exposes `landmarks`, `worldLandmarks`, and handedness classifications with scores. Configurable detection/presence/tracking thresholds remain as **configuration**, not as outputs. Tracking continuity is now based on actual observations (frame presence, position, handedness label and score) and game-computed heuristics.
2. **Worker decision rule corrected.** No longer requires worker round-trip latency to beat main-thread inference duration. Decision now evaluates sustained render FPS, frame-time stability, end-to-end landmark latency, achieved inference frequency, and reliability together. A worker may be worthwhile with somewhat higher round-trip latency if it materially improves smoothness without unacceptable control lag.
3. **M0 terminology corrected.** M0 produces an **interactive mouse/touch hand simulator** that can later serve as the playable fallback. It is not described as a "playable game" until M3/M4 gameplay systems exist. M0 scope unchanged.
4. **Mirroring clarified.** Both the rendered video image and the detected landmarks must appear mirrored consistently. Text and HUD elements remain readable and unmirrored. Verification tests the complete video-to-canvas rendering pipeline, not just the landmark transform.

### v1 → v2 revisions (carried forward)

5. Inference is adaptive, not fixed. The "24–30 Hz inference" success condition is removed. Rendering FPS and inference frequency are decoupled.
6. Web Worker inference is an explicit M1 decision gate, not a default.
7. Persistent hand identity is a first-class subsystem.
8. Gesture thresholds marked unverified; require adult and child validation. Release-to-rearm added.
9. Alternating-hand rule clarified: wrong hand gets feedback, no score, no target consumption, no change to `lastScoringHand`.
10. Coordinate system section hardened (intrinsic video dimensions, canvas backing store, CSS sizing, orientation, mirroring).
11. Camera denial handled in M1, not M6.
12. Offline behavior clarified. Self-hosted runtime assets ≠ true offline. No service worker in v1.
13. Cost-measurement workflow added.
14. Experiment protection added.
15. Fabricated confidence metrics banned.
16. Project context updated. Product name: **Web Slinger**.

---

## 1. Objective

A standalone browser game where a player uses their real hands, tracked through the webcam, to sling webs like Spider-Man. The player performs the web gesture (middle and ring fingertips pressed to the palm, index and pinky extended), and a web fires from the **on-screen position of their actual hand** to a target. Hands must alternate. Runs in Chrome on the **primary device**, a laptop (see the v3 changelog), with the Pixel 10 Pro XL as a secondary target. All processing on-device. No backend.

**Primary audience:** a young child. Design for delight and forgiveness, not difficulty.

**Secondary purpose:** this project doubles as a real, unsubsidized measurement of agentic software development cost using DeepSeek Harness and the DeepSeek API. See §14.

---

## 2. Non-Goals (Binding Scope Fences)

Out of scope for v1. Do not build unless a later revision explicitly adds it.

- ❌ Rigged 3D Spider-Man avatar / pose retargeting onto a 3D model
- ❌ Full-body pose tracking (hands only)
- ❌ Multiplayer, networking, accounts, cloud persistence
- ❌ Server-side anything. No backend, no API calls at runtime, no telemetry.
- ❌ 3D rendering engine (Three.js, Babylon, etc.)
- ❌ Level editor, asset pipeline, CMS
- ❌ Monetization, ads, analytics
- ❌ Service worker / true offline support (see §9)
- ❌ Custom telemetry infrastructure (see §14)

If the agent finds itself reaching for any of these, stop and ask.

---

## 3. Success Criteria

A round is "done" when, on the primary device (a laptop running desktop Chrome — see
the v3 changelog):

1. Camera permission is requested via an explicit user tap (this also unlocks audio).
2. Both hands are tracked in real time; the mirrored video and landmarks visually align with the player's real hands, while HUD and text remain readable and unmirrored.
3. Rendering holds **≥30 FPS sustained** on the primary device during active play. Inference frequency is whatever the device can sustain *without violating the render budget* — it is not a fixed target.
4. The web gesture fires a web from the correct hand. It does not fire spuriously during ordinary hand movement, after tracking loss, or on reacquisition.
5. A web visually connects the player's palm to a target, with an impact effect.
6. Alternating hands is enforced and communicated in the HUD.
7. A full round can be completed with a win state and replay.
8. A mouse/touch simulator mode exists, is playable once game systems exist (M4), and is offered automatically if the camera is unavailable or permission is denied.

---

## 4. Project Context and Existing Evidence

### 4.1 Project context

- Standalone browser game, own GitHub repository.
- Product name: **Web Slinger**. Do not rename.
- Not a ToyStage mode. Not an OpenTarsus integration. Independent.
- Implementation via **DeepSeek Harness (DSH)** against the **DeepSeek API**, starting with **DeepSeek V4.1 Flash**, escalating only if justified by measured need.
- Keep implementation and runtime dependencies minimal.

### 4.2 Prior evidence from ToyStage (do not over-read)

A separate MediaPipe-based pose-tracking app (ToyStage) was previously measured on the same Pixel 10 Pro XL in Chrome 154:

| Metric | Value |
|---|---|
| Canvas rendering | 29.5 FPS |
| Full-body pose sampling | 8.7 Hz |
| Inference time | 78.6 ms |
| Round-trip inference | 79.6 ms |

**These are not hand-tracking benchmarks.** Full-body pose estimation and hand landmark detection are different models with different cost profiles. These numbers are included for one reason only:

> They establish that assuming a fixed useful inference rate on this device is unsafe, and that inference cost must be measured rather than assumed.

Hand tracking with `HandLandmarker` may be faster or slower than the pose pipeline. It must be measured on-device during M1.

---

## 5. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Build | **Vite + TypeScript** | Fast HMR, first-class TS, trivial static deploy |
| Rendering | **Canvas 2D** for v1 | Simplest correct thing. Upgrade path noted in §18 |
| Hand tracking | **`@mediapipe/tasks-vision`** (HandLandmarker) | Mature in-browser option, 21 landmarks × 2 hands, on-device |
| Segmentation (M5 only, optional) | MediaPipe **ImageSegmenter** (selfie model) | Visual polish only, toggleable, off by default |
| Smoothing | **One Euro Filter** (hand-rolled, ~40 LOC) | Low latency + low jitter; better than EMA here |
| Audio | **Web Audio API** | Synthetic SFX, no asset licensing |
| Package manager | npm | — |

**Version pinning is mandatory.** MediaPipe's Tasks API and model filenames have churned across releases. Pin `@mediapipe/tasks-vision` to an exact version (no `^`), download the `.task` model and the WASM assets into `public/`, and self-host them. Do not depend on a CDN at runtime.

**Verify current model URL and WASM asset paths against the installed version's documentation before writing code against them.** Treat any URL in this document as a placeholder to confirm.

### 5.1 MediaPipe output contract (corrected)

Per the JS `HandLandmarkerResult`, the fields we consume are:

- `landmarks`: normalized landmarks `[0,1]` relative to the video's intrinsic dimensions, 21 points per detected hand
- `worldLandmarks`: metric-space landmarks (not used in v1; see §8 Rule C)
- `handedness` / `handednesses`: one classification per detected hand, each carrying a category label (`"Left"` / `"Right"`) and a `score`

**These are the only model outputs consumed.** The `HandLandmarkerOptions` thresholds — `minHandDetectionConfidence`, `minHandPresenceConfidence`, `minTrackingConfidence` — are **configuration inputs**, not per-hand outputs. Do not treat them as observable values. Do not log them as measurements.

Any per-hand continuity, identity-match, or gesture metric in this codebase is a **game-computed heuristic** derived from frame-to-frame observations and landmark geometry. It must be named to reflect that (see §6.2).

---

## 6. Architecture

```
src/
  main.ts                 // bootstrap, wiring, top-level state
  config.ts               // ALL tunable constants in one place
  platform/
    camera.ts             // getUserMedia, video element, permission/error handling
    audio.ts              // Web Audio context, unlock-on-gesture, SFX synth
    raf.ts                // requestVideoFrameCallback wrapper with rAF fallback
    orientation.ts        // resize / orientationchange handling
  tracking/
    handTracker.ts        // HandLandmarker wrapper; main-thread or worker per §7
    inferenceWorker.ts    // worker entry (only if the M1 decision enables it)
    landmarkTypes.ts      // Landmark enum, Handedness, RawHandFrame types
    smoothing.ts          // One Euro filter, per-landmark
    gesture.ts            // pure: classifyGesture(landmarks) -> GestureResult
    handIdentity.ts       // stable left/right association across frames
    handState.ts          // per-identity state machine
  sim/
    replaySource.ts       // JSON landmark replay
    mouseSource.ts        // mouse/touch-driven synthetic hand (interactive simulator)
  game/
    loop.ts               // fixed-timestep update, decoupled from render
    targets.ts            // spawn, movement, hit detection, webbed state
    scoring.ts            // alternate-hand rule, score, progression
    rounds.ts             // round lifecycle, win state
  render/
    stage.ts              // canvas sizing, coordinate transform (§8)
    drawVideo.ts          // mirrored video draw + optional segmentation cutout
    drawHands.ts          // debug landmark overlay (toggleable)
    drawWeb.ts            // bezier web, sag, splat
    drawHud.ts            // score, hand indicator, debug stats (unmirrored)
    fx.ts                 // particles, screen shake, comic pops
  debug/
    hud.ts                // FPS, inference Hz, latency, gesture score, state
    recorder.ts           // record landmark sequences to JSON for fixtures
public/
  models/hand_landmarker.task
  wasm/                   // MediaPipe vision wasm bundle
docs/
  COST_LOG.md             // per-milestone cost record (§14)
  TEST_MATRIX.md          // agent-testable vs human-device-required (§16)
```

### 6.1 Data Flow (one frame)

```
video frame
  -> HandTracker.detect()      -> RawHandFrame[]  (21 landmarks, handedness label + score)
  -> HandIdentity.associate()  -> StampedHandFrame[] (stable identity = "left" | "right")
  -> Smoothing.apply()         -> SmoothedHandFrame[]
  -> Gesture.classify()        -> { isGesture, gestureScore }
  -> HandState.update()        -> emits FIRE (identity, palmCenter, timestamp)
  -> GameLoop consumes FIRE    -> resolve aim -> WebProjectile
  -> Renderer draws mirrored video + mirrored landmarks + webs + targets + fx + unmirrored HUD
```

**Key principle:** `tracking/` and `sim/` are pure. No DOM, no canvas, no MediaPipe types leaking across their public interfaces. This is what makes unit tests and the replay harness possible.

### 6.2 Naming discipline: API outputs vs. computed values

**Model outputs consumed from MediaPipe:**

- `landmarks` (normalized, per hand)
- `handedness` classification: `{ label, score }` per hand

**Game-computed values** must have distinct names and a comment stating they are heuristics:

- `gestureScore` — geometry-based match quality, computed by `gesture.ts`
- `identityMatchScore` — association cost fit, computed by `handIdentity.ts`
- `staleness` — ms since last observation for a given identity
- `aimPlausibility` — optional, for aim resolution

None of these is a model confidence. Never present a computed heuristic as a model output in code, logs, or the HUD.

---

## 7. Inference: Adaptive Scheduling and Worker Decision

This section supersedes any fixed inference-rate target. **Inference frequency is not a success condition.** Rendering FPS is.

### 7.1 Rendering and inference are separate loops

- **Render loop** targets ≥30 FPS sustained on the primary device.
- **Inference loop** runs at whatever rate the device can sustain without stealing the render budget.
- Inference scheduling is adaptive: measure recent inference wall-time, maintain an estimate, and schedule the next detection when the predicted cost fits inside the frame budget.
- Config knobs (all in `config.ts`): `minInferenceHz`, `maxInferenceHz`, `inferenceBudgetFraction`, `resolutionCap`.

### 7.2 Rendering between detections — and what it is not

Between detections, landmark positions can be advanced for **rendering only** using the smoothed filter state (One Euro extrapolation) or linear interpolation between the last two detections.

This is a rendering technique. It is **not additional tracking information.** Do not:

- Feed interpolated frames to the gesture classifier
- Treat interpolated positions as observations in the filter
- Report interpolated frames as increased inference rate in the debug HUD

Label the HUD clearly: `render FPS`, `inference Hz (measured)`, `interpolated frames drawn since last detection`. If the last detection is older than `maxInterpolationAgeMs`, stop advancing the hand and mark it stale in the HUD. Do not let a lost hand drift.

### 7.3 Main-thread blocking: the worker decision gate

MediaPipe's `HandLandmarker.detectForVideo()` is **synchronous**. On the main thread it blocks rendering for the duration of inference. The ToyStage measurement (79 ms round-trip for pose) suggests that, on this device, main-thread inference at any useful rate may consume most or all of a 33 ms frame budget unless inference is fast enough or off-thread.

**This is a decision gate, not a default.** The plan does not assume workers improve performance. Evaluate during M1.

#### Options to evaluate

1. **Main-thread synchronous inference** (baseline). Measure blocking time per call and observed render FPS under load.
2. **Worker with `ImageBitmap` transfer.** Main thread calls `createImageBitmap(video)` (async, non-blocking), transfers the bitmap to a worker via `postMessage` with transfer list. Worker runs inference on the bitmap and posts back landmarks. `ImageBitmap` is transferable; transfer is zero-copy in spec.
3. **Worker with `VideoFrame` (WebCodecs) transfer.** `new VideoFrame(video)` on the main thread, transfer to worker. `VideoFrame` is transferable and designed for this. Requires WebCodecs support (Chrome yes, Safari 16.4+, Firefox yes). Slightly cleaner lifecycle but more platform surface.
4. **Worker with `OffscreenCanvas`.** Draw the video into an `OffscreenCanvas` owned by the worker, run inference there. Higher complexity; evaluate only if 2 and 3 fail.

#### Evaluation criteria (corrected)

The decision is **holistic**, not a single-metric comparison. A worker may be worthwhile even when its round-trip latency is somewhat higher than main-thread inference duration, provided it improves overall smoothness without introducing unacceptable control lag.

Measure on the primary device, for each candidate configuration:

- **Sustained render FPS** during active play (p50, p05)
- **Frame-time stability** — variance and p95 frame time (stutter matters more than mean)
- **End-to-end landmark latency** — time from video frame availability to landmarks reaching the game loop (p50, p95)
- **Achieved inference frequency** — actual Hz sustained under load
- **Control lag felt by a human** — a qualitative rating recorded during M1 playtest
- **Reliability** — initialization success rate, failure modes, fallback frequency, memory behavior over 5 minutes
- **Main-thread blocking** in the baseline configuration (for comparison)

#### Decision rule (corrected)

Adopt a worker if, taken together, the worker configuration:

- Improves **sustained render FPS** and/or **frame-time stability** meaningfully, **and**
- Does not introduce **end-to-end latency** large enough to feel like control lag in playtest, **and**
- Has acceptable **reliability** (initializes reliably, does not degrade over a session), **and**
- Has a working main-thread fallback implemented and tested.

A worker is **not** required to have lower round-trip latency than main-thread inference. A somewhat higher round-trip that yields smoother rendering and steadier frame pacing can be the better trade for a child-facing game, as long as the web gesture still feels responsive.

If the worker path does not meet the above, stay on main thread, lower inference rate, and accept the render cost.

#### Fallback behavior (mandatory regardless of decision)

- If the worker fails to initialize (unsupported APIs, WASM load failure, GPU delegate failure), automatically fall back to main-thread inference.
- If `VideoFrame` transfer is unavailable, fall back to `ImageBitmap`.
- If neither transfer path is available, fall back to main thread.
- Every fallback transition must be logged and surfaced in the debug HUD.

#### Other inference hardening

- Use the **GPU delegate** where available; catch initialization failure and fall back to CPU.
- `numHands: 2`. Set the configurable detection, presence, and tracking thresholds in `config.ts`. Remember: these are inputs, not outputs (§5.1).
- Input resolution default **640×480**. Raise only on desktop if measurements justify it.

---

## 8. Coordinate Systems, Mirroring, and the Rendering Pipeline

This is the #1 bug source. Handle it explicitly and early.

Three spaces exist:

1. **Video space** — MediaPipe output. Normalized `[0,1]` relative to the video's intrinsic dimensions. Origin top-left. Unmirrored (as captured).
2. **Canvas space** — canvas pixels, origin top-left. The drawing surface.
3. **CSS / screen space** — how the canvas is laid out in the viewport.

### Rules

**Rule A — Canvas backing store equals video intrinsic dimensions.** Set `canvas.width = video.videoWidth`, `canvas.height = video.videoHeight` and re-sync whenever those change. Fit to the viewport using CSS only (`max-width: 100%; max-height: 100%; object-fit: contain` on a wrapper, or equivalent). This makes normalized→canvas a pure multiply. Do not letterbox inside the canvas.

**Rule B — Mirror the video image and the landmarks, together, in one place.** Both the rendered video and the landmark positions must appear mirrored consistently. HUD text, comic pop text, and any other UI must remain readable and **unmirrored**.

Implement mirroring by **flipping x in code**, not by CSS `scaleX(-1)` on the canvas element, because a CSS flip would also flip HUD text and any DOM UI layered above it. The single conversion for landmarks:

```ts
// THE ONLY place normalized video space becomes canvas space.
function toCanvas(lm: NormalizedLandmark, cw: number, ch: number): Vec2 {
  return { x: (1 - lm.x) * cw, y: lm.y * ch }; // 1-x == horizontal mirror
}
```

The video frame itself is drawn mirrored with the same convention — either by drawing with a horizontal flip in the same canvas space, or by drawing into the canvas with a `setTransform(-1, 0, 0, 1, cw, 0)` established at the top of the video pass and cleared before HUD. Pick one approach, document it, and use it consistently. **Do not mix a code flip and a CSS flip** — that produces a double-mirror for one layer and not the other.

**Rule C — Ignore MediaPipe's `z` for v1.** It is relative and noisy. Never use it for screen position. Do not use `worldLandmarks` in v1.

**Rule D — Device orientation and video resize.** Subscribe to `orientationchange` and to the video element's `resize` event (or poll `videoWidth`/`videoHeight` each frame and re-sync on change). On any change, re-set the canvas backing store and re-apply the layout. Do not cache canvas dimensions across orientation changes.

**Rule E — No second coordinate system.** Aim vectors, target positions, and web origins all live in canvas space. If a subsystem needs normalized space, it converts back through the inverse of `toCanvas` and says so in a comment.

**Rule F — Visual assertion gate for the whole pipeline.** In M1, before any game code, the full video-to-canvas pipeline must be verified end to end: the mirrored video must render correctly **and** a dot drawn at every landmark must sit exactly on the real hand **and** any HUD text drawn on top must read correctly (unmirrored). This is a pipeline test, not only a landmark-transform test. If landmarks are misaligned, the fix is the pipeline (Rule B), not a fudge factor elsewhere.

### Handedness gotcha

MediaPipe's handedness label (`"Left"` / `"Right"`) is defined relative to a specific mirroring assumption, and a mirrored pipeline can invert it. **Do not trust the label on first integration.** In M1, physically raise the right hand and log the label. If inverted, apply a single global swap in `handTracker.ts` with a comment, and add a regression item to the manual checklist. This is separate from identity association (§10).

---

## 9. Runtime Assets and Offline Behavior

Two different things, often conflated:

- **Self-hosted runtime dependencies**: MediaPipe WASM and the `.task` model served from the same origin as the app. This is **required**.
- **True offline support**: the app loads and runs with no network at all, including after first visit. Requires a **service worker**.

**v1 decision: self-host all runtime assets. Do not add a service worker.** Rationale:

- The game requires a camera and a user present. It is not a "use it on a plane" app.
- A service worker adds maintenance surface: cache versioning, update flow, cache invalidation, stale-build bugs.
- Offline play is not a stated requirement.

Document this tradeoff in the repo README. If a service worker is added later, do it as an explicit, isolated change with its own tests.

---

## 10. Hand Identity and Per-Hand State

v1 associated state with detection array position. That is unsafe: MediaPipe's array order is not guaranteed stable across frames, and hands cross, occlude, and leave the frame. **Do not key state on array position.**

### 10.1 Identity association (corrected inputs)

Maintain a stable identity of `"left"` and `"right"` across frames. Association inputs, in priority order, from **actual observations only**:

1. **MediaPipe handedness label and score** (after the M1 correctness fix in §8). Primary signal when present and stable.
2. **Previous-frame canvas position** — distance between this frame's palm centers and the last known palm center per identity. Primary continuous signal, especially during crossing.
3. **Computed continuity heuristic** — for each identity, a `staleness` value (ms since last observation) and an `identityMatchScore` computed from handedness agreement and palm-center distance. Both are game-computed, not model outputs (§6.2).

There is no per-hand detection/presence/tracking confidence output from the model. Continuity is determined from: whether a hand was observed this frame, where it was, and what handedness was reported.

Association algorithm sketch (invariants are binding, exact method is implementation detail):

- For each new detection, compute a match cost against each currently tracked identity: handedness mismatch is a large penalty; palm-center distance is the primary continuous term; `staleness` is a decay term.
- Greedy or Hungarian assignment (greedy is fine for two hands).
- If a detection cannot be matched within a configurable distance, treat it as a **new** identity only when it is not explained by an identity that already exists. Two cases block adoption, and only these two:
  - **Mis-association.** Some identity is inside its grace period *and was not observed this frame*. The detection may be that same hand, so adopting it would duplicate one hand.
  - **Duplicate observation.** The detection lies within the match radius of a hand already placed this frame — the model reported one hand twice. Adopting it would invent a phantom identity.

  A detection that is far from every hand placed this frame, while the other identity *was* observed this frame, is a **genuinely new opposite hand** and must be adopted into the free slot. (v1 stated this rule as "only if no identity is currently in a grace period", which is unfalsifiable in two-handed play: a visible hand is always inside its own grace window, so the second hand could never be adopted at all.)

- If an identity is not matched for longer than `identityGraceMs`, mark it **lost**. On reacquisition, prefer the identity whose last known position is closest, unless handedness strongly contradicts.

### 10.2 Crossing hands

When palm centers come within a configurable radius of each other, **prefer handedness over position** for the crossing window. Suppress identity reassignment during crossing. Log a debug counter of crossings observed per session; if crossings produce identity swaps in playtest, adjust the crossing radius.

### 10.3 Occlusion, disappearance, reacquisition

- **Grace period** (per identity): when a hand is momentarily unseen, freeze the identity's state machine rather than resetting it. Hold the last known position for rendering, marked stale.
- On grace expiry: reset the identity's state machine to `IDLE` and stop rendering the hand.
- On reacquisition: enter a **rearm block** — the gesture state machine must observe the hand in the "not gesturing" state for at least `rearmMs` before it can arm again. This prevents a spurious `FIRE` immediately on reacquisition if the hand re-enters the frame already in the gesture pose.

### 10.4 Model outputs vs. computed heuristics

Consumed model outputs: `landmarks`, handedness `{ label, score }`. That is all.

Game-computed values used in identity and state: `identityMatchScore`, `staleness`, `gestureScore`. These are heuristics computed from observations. They are **never** to be labelled or surfaced as model confidences. The debug HUD shows them under a clearly separated "computed" group.

---

## 11. Gesture Detection

The gesture: **index and pinky extended; middle and ring folded to the palm.**

### 11.1 Normalized geometry

Normalize by hand span so the gesture works across hand sizes — adult and child.

```ts
// Wrist(0) to middle MCP(9). Stable, usually visible.
const span = dist(lm[0], lm[9]);

// Palm center: average of wrist + the five MCPs.
const palm = centroid([lm[0], lm[5], lm[9], lm[13], lm[17]]);

const middleToPalm = dist(lm[12], palm) / span;
const ringToPalm   = dist(lm[16], palm) / span;

const indexExt = dist(lm[8],  lm[0]) / span;
const pinkyExt = dist(lm[20], lm[0]) / span;

const folded   = middleToPalm < FOLD_ENTER && ringToPalm < FOLD_ENTER;
const extended = indexExt > EXT_ENTER && pinkyExt > EXT_ENTER;
```

### 11.2 Unverified thresholds

**The following are initial guesses, not validated values.** Tune against real hands in M2. All live in `config.ts`.

- `FOLD_ENTER = 0.35`, `FOLD_EXIT = 0.50`
- `EXT_ENTER = 1.10`, `EXT_EXIT = 0.90`
- `MIN_GESTURE_SCORE = 0.6` (see §11.4)
- `HOLD_MS = 150`
- `COOLDOWN_MS = 400`
- `REARM_MS = 150`

### 11.3 Hysteresis

Asymmetric enter/exit thresholds prevent flicker on the boundary.

### 11.4 Gesture score (computed, not API)

`gestureScore` is a heuristic in `[0,1]` derived from how far past the thresholds the pose is. It is computed by the game. It is **not** a model confidence. State machines require `gestureScore >= MIN_GESTURE_SCORE` to arm.

### 11.5 Curled-finger orientation check (M2 task)

The `middleToPalm` / `ringToPalm` distance check assumes the curled fingertip is near the palm regardless of hand orientation. Verify in M2 at:

- Palm facing camera (baseline)
- Palm facing away
- Hand edge-on (pinky-side toward camera)
- Hand tilted forward (fingers pointing up-and-away)
- Hand tilted back (fingers pointing up-and-toward)

If the classifier fails reliably at any orientation, consider a geometry fallback (e.g. PIP joint angle) rather than loosening the distance threshold.

### 11.6 Smoothing, kept separate

Apply a **One Euro Filter per landmark per identity**. Starting defaults: `minCutoff ≈ 1.5`, `beta ≈ 0.01`, `dCutoff ≈ 1.0`. Require tuning.

**Classify the gesture on a lightly-smoothed copy, render from the heavily-smoothed copy.** Two filter instances, or classify on a lightly-filtered stream.

### 11.7 Release-to-rearm

A held gesture must not repeatedly fire every time `COOLDOWN_MS` expires.

```
IDLE ──(gesture && score>=MIN)──> ARMED
ARMED ──(held HOLD_MS)──> FIRE ──> COOLDOWN
ARMED ──(gesture lost)──> IDLE
COOLDOWN ──(gesture still held)──> HELD
HELD ──(gesture released)──> IDLE
HELD ──(COOLDOWN_MS elapsed && gesture still held)──> stays HELD  // no fire
FIRE ──(gesture released before cooldown ends)──> COOLDOWN
```

**Invariant: a FIRE transition requires a fresh arming edge.** Holding the gesture never re-fires.

### 11.8 No spurious FIRE after tracking loss

On identity loss (grace expiry), reset that identity's state machine to `IDLE` and clear the gesture-armed latch. On reacquisition, enter the **rearm block** (§10.3): the state machine must observe the released state for `REARM_MS` before arming is possible.

---

## 12. Game Systems

### 12.1 Aiming — open design question, defaults proposed

- **Model A — Auto-aim (default).** Fire at the nearest target within a generous cone from the palm, or the nearest target on screen. Show a reticle that snaps to the chosen target.
- **Model B — Point-to-aim.** Aim vector = `normalize(indexTip - wrist)`. Fire along that ray with a small angular tolerance.

**Default: Model A.** Model B behind a config flag and difficulty toggle.

### 12.2 Web rendering

- **Origin:** palm center.
- **Path:** quadratic Bézier from palm to impact point, control point sagging downward proportional to distance.
- **Rendering:** `lineWidth` scaled by distance; a thinner bright core line for a comic look; optional slight path jitter.
- **Travel:** animate the web tip along the curve over ~120 ms.
- **Impact:** a "splat" — short radiating lines scaling up then fading.
- **Webbed target:** wrapped in a web overlay, becomes inert.

### 12.3 Game loop

- **Fixed timestep update (60 Hz) decoupled from render.**
- Round structure: N targets spawn → clear → win screen → replay.
- **No fail state.** Optional challenge mode out of scope for v1.

### 12.4 Alternating-hand rule

Track `lastScoringHand` (the hand that most recently scored). The next scoring fire must come from the other hand.

**Wrong-hand fire behavior:**

- Produces harmless audiovisual feedback.
- Does **not** score.
- Does **not** consume or web a target.
- Does **not** change `lastScoringHand`.
- Does **not** change the required next hand.

**State-machine interaction.** The wrong hand's state machine runs through FIRE → COOLDOWN → HELD/IDLE normally so the gesture feels responsive, but scoring is not enabled by cooldown expiry alone. To attempt a **scoring** fire, the wrong hand must release and rearm (§11.7). A wrong hand cannot spam fires hoping one eventually counts.

On `FIRE`:

- If `event.identity !== lastScoringHand` (or `lastScoringHand === null`), attempt scoring resolution and set `lastScoringHand = event.identity`.
- Otherwise, play wrong-hand feedback and do not mutate game state.

The HUD shows which hand is "next."

### 12.5 Feedback and polish (M5)

- **Audio:** synthetic "thwip" via a short noise burst with a pitch envelope. `AudioContext` created or resumed inside a user gesture.
- **Screen shake** on impact: subtle, heavily damped.
- **Comic pop text** at impact.
- **Segmentation cutout (optional, off by default on mobile):** quality tiers `high` / `medium` / `low`.

---

## 13. Milestones

Each milestone is independently testable. **Do not begin M(n+1) until M(n)'s acceptance test passes.** Acceptance tests are marked:

- **[A]** agent-testable
- **[H]** human/device required
- **[A+H]** both required

An agent may not declare a milestone accepted on [A] evidence alone if any acceptance criterion is [H]. See §16.

### M0 — Dev Harness, Replay, and Interactive Mouse/Touch Hand Simulator

Vite + TS scaffold. Canvas sized to a fake 640×480 source. `ReplaySource` emitting scripted landmark sequences from JSON. `MouseSource` producing a plausible synthetic hand driven by mouse or touch. Render loop drawing landmarks as dots. `docs/COST_LOG.md` and `docs/TEST_MATRIX.md` skeletons.

The mouse/touch simulator is an **interactive hand simulator**, not a game. It becomes a playable fallback once M3/M4 gameplay systems exist. It must be architected so the same game code can drive it and the camera path.

**Acceptance [A]:**
- `npm run dev` shows synthetic landmarks animating on screen, driven by the mouse or a replay file.
- No camera involved. No game systems yet.
- Unit tests exist for the coordinate transform `toCanvas` and pass.

### M1 — Camera, Real Tracking, Identity, and the Worker Decision

Integrate MediaPipe HandLandmarker. Mirrored video drawn to canvas. Real landmarks drawn on top. Implement `handIdentity.ts` (§10). Handle **camera permission denial and no-camera** by automatically offering the M0 simulator as the input source — not as an error screen. Verify handedness label empirically (§8). Make the **worker decision** (§7) based on the holistic criteria, or explicitly defer it with a recorded rationale. Verify the **full rendering pipeline** (§8 Rule F): mirrored video, mirrored landmarks, unmirrored HUD.

**Acceptance [H]:**
- Mirrored video and landmarks both align with the real hands on screen; HUD text reads correctly (unmirrored).
- Handedness label verified empirically and corrected if needed.
- Identity association survives a hand crossing and a hand leaving/re-entering frame without swapping.
- Camera denied → simulator offered and usable, no dead end.

**Acceptance [A]:**
- Worker decision recorded in `docs/` with measured numbers (or an explicit deferral with rationale).
- Identity association unit tests pass against recorded landmark sequences.

### M2 — Gesture Detection and Tuning

Classifier, hysteresis, One Euro smoothing, per-identity state machines, debug HUD with per-hand state, `gestureScore`, and tunable thresholds displayed live. Tune against real hands.

**Acceptance [A]:**
- Unit tests for `classifyGesture` against a fixture set covering folded/extended/ambiguous poses.
- Unit tests for the state machine: release-to-rearm, no-fire-while-held, rearm-block-on-reacquisition.

**Acceptance [H]:**
- Gesture fires reliably when performed deliberately by an **adult** hand.
- Gesture fires reliably by a **child's** hand. If the child is unavailable, this is recorded as deferred and the milestone is **not** fully accepted.
- Ordinary hand movement does **not** fire.
- Gesture tested at the five orientations in §11.5; failures documented.
- Tuned thresholds committed to `config.ts` with a comment recording device and hand used.

### M3 — Webs and Targets

Web rendering from palm to target, travel animation, impact splat. Static targets with hit detection and webbed state.

**Acceptance [A]:** hit detection and target state unit tests pass.
**Acceptance [H]:** on the primary device, performing the gesture at a target produces a correct-looking web originating from the hand and splatting on the target.

### M4 — Full Round

Target spawning, alternating-hand scoring, HUD, progression, win state, replay. With M3/M4 in place, the M0 simulator now provides a **playable simulator mode**.

**Acceptance [A]:** scoring and alternation state machine unit tests pass, including the wrong-hand no-op rule (§12.4).
**Acceptance [H]:** a complete playable round start to finish on the primary device.

### M5 — Polish

Audio, screen shake, comic pops, optional segmentation cutout, quality tiers, mobile performance tuning, iOS-specific fixes.

**Acceptance [H]:** runs at ≥30 FPS sustained on the primary device at the chosen quality tier; feels good in playtest.

### M6 — Hardening and Cross-Browser

Extended permission-denied paths, tracking-loss recovery beyond M1 cases, error surfaces, graceful degradation on unsupported browsers, Safari/Firefox checks.

**Acceptance [H]:** every failure path produces a clear message and a playable alternative where possible.

---

## 14. Cost-Measurement Workflow

The project measures real, unsubsidized agentic development cost. The measurement is **lightweight** and adds no runtime or infrastructure complexity.

### 14.1 What is recorded

For each milestone, append one row to `docs/COST_LOG.md`:

| Field | Source |
|---|---|
| Milestone | manual |
| Model (e.g. `deepseek-v4.1-flash`) | DSH |
| DSH version | DSH `--version` or equivalent |
| Input tokens, cache miss | DSH usage report, if exposed |
| Input tokens, cache hit | DSH usage report, if exposed |
| Output tokens | DSH usage report, if exposed |
| Reasoning tokens | DSH usage report, if exposed |
| Actual API dollars spent | DSH usage report, if exposed |
| Agent turns | DSH session log |
| Retries / corrective prompts | DSH session log |
| Tests run / passed | local test runner output |
| Manual device tests remaining | `docs/TEST_MATRIX.md` |
| Notes | manual |

### 14.2 Rules

- **Do not invent numbers.** If DSH does not expose a field, write `unavailable` and, if possible, note how it could be obtained or why it is not.
- **Do not build telemetry infrastructure.** No custom collectors, no log parsing pipelines, no dashboards.
- **Do not attribute costs to the game runtime.**
- **One row per milestone**, appended at completion. Do not backfill.

### 14.3 Test matrix

`docs/TEST_MATRIX.md` lists every acceptance test from §13 with its `[A]` / `[H]` / `[A+H]` classification and a checkbox. The agent updates `[A]` rows. The human updates `[H]` rows. A milestone's `[H]` rows must all be checked before full acceptance.

**If a required device or hand test is unavailable at milestone time, mark the row `pending` and request explicit human approval before proceeding to the next milestone.** Do not represent a pending test as passed. Do not proceed to M(n+1) on a milestone whose `[H]` rows are pending without that approval.

---

## 15. Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Coordinate/mirroring bug — video and landmarks inconsistent, webs from wrong place | Critical | Single `toCanvas()` and single video-flip convention (§8). Full-pipeline visual gate in M1. Do not proceed past M1 until correct. |
| 2 | Handedness label inverted | High | Empirical verification in M1. Single documented swap. Regression item. |
| 3 | Inference blocks rendering on the primary device | High | Worker decision gate (§7.3). Adaptive scheduling. Main-thread fallback. |
| 4 | Render FPS below 30 on the primary device | High | Separate render and inference loops. Cap input resolution. GPU delegate with CPU fallback. Quality tiers. Measure, don't assume. |
| 5 | Identity swap on crossing / reacquisition | High | `handIdentity.ts` (§10). Prefer handedness during crossing. Rearm block. Fixture-based unit tests. |
| 6 | Gesture false positives during ordinary movement | High | Hysteresis + normalization + `HOLD_MS` + `gestureScore` floor. Tuned in M2. |
| 7 | Gesture unreliable at oblique hand angles | High | §11.5 orientation test in M2. Auto-aim is angle-agnostic. Consider PIP-angle fallback. |
| 8 | Spurious FIRE after tracking loss | High | Rearm block (§10.3, §11.8). Unit tested. |
| 9 | Small hands fail thresholds | Medium | Normalize by hand span (§11.1). Explicit child-hand test in M2. If unavailable, M2 not fully accepted. |
| 10 | Two hands confusable / swapped | Medium | Handedness + position + continuity (§10). Debug counter for crossings. |
| 11 | MediaPipe API / model churn breaks asset paths | Medium | Exact version pin. Self-hosted assets. Verify against installed version docs before coding. |
| 12 | iOS Safari quirks (autoplay, audio, fullscreen video, WebCodecs) | Medium | `playsinline` + `muted`; `AudioContext` resumed on user gesture; explicit iOS pass in M6. |
| 13 | Camera permission denied / no camera | Medium | M1 simulator fallback. Not deferred to M6. |
| 14 | Worker path fails on some browser or device | Medium | Automatic fallback to main-thread inference. Fallback transitions logged. |
| 15 | Scope creep into 3D avatar work | High (schedule) | §2 is binding. |
| 16 | Agent declares camera-dependent acceptance criteria passed on simulation | High | §16. `[A]` / `[H]` classification. Human signs off on `[H]` rows. |
| 17 | Cost log becomes its own infrastructure project | Medium | §14.2. Mark unavailable and move on. |
| 18 | Fabricated model-confidence metrics leak into code or HUD | High | §5.1, §6.2, §10.4. Only `landmarks` and `handedness` are model outputs. Everything else is game-computed and named accordingly. |

---

## 16. Protecting the Experiment

### 16.1 Narrow milestones

Each milestone has one coherent goal and one acceptance test set. Do not bundle.

### 16.2 Libraries: prefer mature, avoid surplus

Use mature libraries where appropriate. Do **not** add dependencies for convenience.

### 16.3 Replay harness and automated tests are retained

`ReplaySource` and `MouseSource` are permanent fixtures. Every non-trivial subsystem has fixtures, unit tests, and documented edge-case behavior.

### 16.4 Agent-testable vs. human-device required

Every acceptance criterion is classified in §13. The agent handles `[A]`; the human handles `[H]`. A milestone is **not fully accepted** until all `[H]` rows are checked by a human.

### 16.5 No simulated sign-off

> **An agent must not declare a milestone fully accepted based on simulated testing if any of its acceptance criteria require actual camera, hand, or device interaction.**

If `[H]` items remain, the agent reports **"agent-complete, pending human device verification"** and lists the exact manual tests remaining. It does not mark the milestone done.

If a required human test cannot be performed at that time (e.g. child-hand gesture validation in M2), the milestone remains open. The deferral is recorded in `docs/TEST_MATRIX.md` as `pending`, and the agent **requests explicit human approval before proceeding to the next milestone**. Pending is never reported as passed.

---

## 17. Manual Test Checklist

Run before declaring any milestone done. `[H]` unless marked.

- [ ] Right hand raised → landmarks align with the real right hand
- [ ] Left hand raised → landmarks align with the real left hand
- [ ] Both hands raised → both tracked, not swapped
- [ ] Handedness label matches physical hand
- [ ] Mirrored video renders correctly, and HUD text reads correctly (unmirrored) on top of it — **full pipeline test, not landmark-only**
- [ ] Hands cross → no identity swap
- [ ] Hand leaves frame mid-gesture → no spurious fire on return
- [ ] Gesture performed by adult → fires
- [ ] Gesture performed by child → fires *(deferred if child unavailable; milestone stays open; request explicit approval to proceed)*
- [ ] Waving / reaching / pointing / scratching head → does **not** fire
- [ ] Gesture at oblique orientations (§11.5) → behavior documented
- [ ] Gesture held continuously → fires once, does not re-fire on cooldown expiry
- [ ] Wrong-hand fire → feedback plays, no score, no target consumed, `lastScoringHand` unchanged
- [ ] Alternate-hand rule enforced; HUD indicates next hand
- [ ] Round completes; win state shows; replay works
- [ ] Camera permission denied → simulator offered and usable
- [ ] Device rotated mid-play → canvas, mirrored video, and landmarks stay aligned; HUD stays readable
- [ ] 5 minutes continuous play on the primary device → no frame-rate collapse, no memory growth
- [ ] Render FPS sustained ≥30 during active play
- [ ] `docs/COST_LOG.md` updated for the milestone
- [ ] `docs/TEST_MATRIX.md` `[A]` rows checked by agent; `[H]` rows checked by human or marked `pending` with explicit approval to proceed

---

## 18. Deferred / Future (Do Not Build Now)

- PixiJS or WebGL renderer if Canvas 2D becomes the bottleneck
- Rigged 3D avatar with pose retargeting
- Additional gestures
- Service worker / true offline support
- Leaderboards, persistence
- Multiple levels, art themes
- Challenge mode

---

## 19. Instructions to the Coding Agent

1. **Work milestone by milestone.** Do not begin M(n+1) until M(n)'s acceptance test passes. If `[H]` tests are pending, report "agent-complete, pending human device verification" and **request explicit human approval before proceeding.** Do not mark done.
2. **All tunable numbers live in `config.ts`.**
3. **`tracking/` and `sim/` stay pure.** No DOM, no canvas, no MediaPipe types in their public interfaces.
4. **The M0 dev harness is permanent.**
5. **Verify MediaPipe API and asset paths against the installed version's documentation before writing code against them.** Flag uncertainty in a comment.
6. **Expose every tunable in the debug HUD.**
7. **Only `landmarks` and handedness `{ label, score }` are model outputs.** Everything else is game-computed and named as such (§5.1, §6.2). Never present a heuristic as a model output.
8. **Do not add a service worker.**
9. **Do not build telemetry infrastructure.** Update `docs/COST_LOG.md` per milestone; mark unavailable fields unavailable.
10. **Mirror the video and landmarks consistently in code; keep HUD unmirrored.** One convention, documented.
11. **Surface uncertainty.** If a requirement is ambiguous or a step is failing, say so and ask.
12. **Respect the scope fences in §2.** If you find yourself reaching for a 3D engine, a backend, or a service worker, stop and ask.

---

## 20. Open Questions for the Human

Answer before M3. Defaults proposed so work is not blocked.

1. **Aiming:** auto-aim (default, recommended for a young child) or point-to-aim? *(Default: auto-aim with a visible snap reticle.)*
2. **Primary device:** **ANSWERED** (v3 changelog) — the maintainer's laptop in Chrome.
   The Pixel 10 Pro XL is a secondary target and gates nothing.
3. **Art style:** raw camera feed with comic overlay, or segmented cutout over a city background? *(Default: raw feed + vignette in v1; cutout as an M5 toggle.)*
4. **Round length & difficulty:** how many targets, how long? *(Default: 8 targets, no timer, no fail state.)*
5. **Do targets move?** *(Default: v1 static; M4 adds slow drifting; no return fire.)*
6. **Child-hand test availability at M2 time.** If unavailable, M2 stays open until it can be done, and explicit approval is required to proceed. Confirm this is acceptable. *(Default: yes, acceptable.)*

---

## 21. First Prompt for DeepSeek Harness — Milestone M0 Only

> Read `PLAN.md` in the repository root. Implement **Milestone M0 only**.
>
> M0 scope:
>
> 1. Scaffold a Vite + TypeScript project with `npm run dev` and `npm test` working. Configure TypeScript in strict mode.
> 2. Create `src/config.ts` and place all tunable constants there. At M0 this includes canvas/video placeholder dimensions and render loop constants.
> 3. Create `src/render/stage.ts` implementing the single `toCanvas()` transform described in §8 of the plan. Write unit tests in `src/render/stage.test.ts` covering: origin, horizontal mirror, edge values, and non-square aspect ratios.
> 4. Create `src/sim/replaySource.ts` that loads a JSON file of landmark sequences and emits frames on a timer. Include one small sample fixture under `fixtures/`.
> 5. Create `src/sim/mouseSource.ts` that produces a plausible synthetic 21-landmark hand driven by mouse position on desktop and touch position on mobile. This is an **interactive hand simulator**, not a game: it will later serve as the playable fallback once M3/M4 gameplay systems exist, and it must expose the same public interface a real tracker will produce so the same game code can consume it unchanged.
> 6. Create `src/tracking/landmarkTypes.ts` defining the raw landmark, handedness, and frame types. Do not import MediaPipe types yet — define our own. Do not include per-hand detection/presence/tracking confidence fields; per the plan, the model does not expose these.
> 7. Create `src/game/loop.ts` with a fixed-timestep update decoupled from rendering.
> 8. Create `src/render/drawHands.ts` that draws a dot at every landmark position, converted through `toCanvas()`.
> 9. Wire `main.ts` to run the render loop and draw landmarks from either `ReplaySource` or `MouseSource`, switchable by a query parameter or key.
> 10. Create `docs/COST_LOG.md` and `docs/TEST_MATRIX.md` with the skeleton tables from §14 of the plan.
>
> Do **not** integrate MediaPipe. Do **not** access the camera. Do **not** start M1. Do **not** implement game systems (targets, webs, scoring) — those belong to M3/M4.
>
> When M0's acceptance criteria pass (`npm run dev` shows animated landmarks driven by mouse or replay; `toCanvas` unit tests pass; no camera involved; no game systems), stop and report:
>
> - What you built, file by file
> - Any deviations from the plan and why
> - Anything you had to guess at or were uncertain about
> - The M0 row for `docs/COST_LOG.md`, with any fields marked `unavailable` if DSH does not expose them
> - The M0 row for `docs/TEST_MATRIX.md` with `[A]` items checked and `[H]` items listed
>
> Do not declare M0 fully accepted if any acceptance criterion requires real camera or device interaction.
