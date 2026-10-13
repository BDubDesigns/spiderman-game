/**
 * ALL tunable constants for Web Slinger live in this file (PLAN.md §19.2).
 *
 * Nothing here is measured or derived at runtime. Every knob the debug HUD
 * eventually exposes (PLAN.md §19.6) is a literal in this module so that tuning
 * never means hunting through feature code.
 *
 * At M0 this covers the placeholder source dimensions, the render/update loop
 * constants, and the simulator's own constants. Gesture thresholds (§11.2),
 * inference scheduling knobs (§7.1) and MediaPipe model options (§7.3) are
 * deliberately NOT here yet — they belong to M1/M2 and adding them now would
 * imply behavior this milestone does not have.
 */

/**
 * Placeholder source ("video") intrinsic size for the M0 harness.
 *
 * PLAN.md §8 Rule A: the canvas backing store equals the source's intrinsic
 * dimensions. At M0 there is no camera, so this fake 640x480 source stands in
 * for `video.videoWidth` / `video.videoHeight`. M1 replaces it with the real
 * video dimensions; `toCanvas()` does not change.
 */
export const SOURCE = {
  width: 640,
  height: 480,
} as const;

/** Fixed-timestep loop constants (PLAN.md §13 M0 item 7). */
export const LOOP = {
  /** Simulation timestep. Fixed, in ms — independent of render rate. */
  fixedDtMs: 1000 / 60,
  /** Clamp a single frame's measured elapsed time (tab backgrounded, stall). */
  maxFrameMs: 250,
  /** Hard cap on update steps per rendered frame, so a stall cannot spiral. */
  maxUpdatesPerFrame: 5,
  /** How many render timestamps the FPS readout averages over. */
  fpsWindowFrames: 60,
} as const;

/** Canvas drawing constants. */
export const RENDER = {
  /** Radius of the debug dot drawn at every landmark (PLAN.md §21.8). */
  landmarkRadiusPx: 4,
  /** Canvas background, drawn before landmarks. */
  stageColor: '#14141f',
  /** Source-space corner markers, used to make mirroring visually obvious. */
  markerColor: '#3a3a52',
  markerRadiusPx: 6,
  markerFont: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
  /** Per-handedness dot colour, so identity is eyeball-checkable. */
  leftColor: '#4ea1ff',
  rightColor: '#ff7a59',
  /** Debug HUD text. Drawn unmirrored, after the mirrored pass (Rule B). */
  hudColor: '#e8e8f0',
  hudBackdropColor: 'rgba(11, 11, 18, 0.72)',
  hudFont: '13px ui-monospace, SFMono-Regular, Menlo, monospace',
  hudPaddingPx: 8,
  hudLineHeightPx: 17,

  // ------------------------------------------------ M3: targets and webs ---
  /** Active target fill. */
  targetColor: '#2b2b3f',
  /** Active target outline. */
  targetRingColor: '#f5c451',
  /** The bright center dot that makes an active target readable at a glance. */
  targetCoreColor: '#f5c451',
  /** A webbed target is inert and dimmed (§12.2). */
  webbedTargetColor: '#6b6b86',
  /** The web line. */
  webColor: 'rgba(232, 232, 240, 0.85)',
  /** The thinner bright core line, for the comic look (§12.2). */
  webCoreColor: '#ffffff',
  /** Impact splat. */
  splatColor: '#f5c451',
  /** The auto-aim reticle (§12.1). */
  reticleColor: 'rgba(245, 196, 81, 0.9)',
} as const;

/**
 * Interactive hand simulator constants (PLAN.md §13 M0, §21.5).
 *
 * The simulator is a permanent fixture (PLAN.md §16.3): it is the playable
 * fallback once M3/M4 exist, so its geometry is normalized by hand span exactly
 * like the real gesture math (§11.1) to keep adult and child hands plausible.
 */
export const SIM = {
  /** Wrist(0) -> middle MCP(9) distance, in canvas pixels, for the fake hand. */
  handSpanPx: 120,
  /** Keep the palm at least this far inside the source, in canvas pixels. */
  palmMarginPx: 40,
  /** Time for the fingers to animate between open and folded, in ms. */
  curlMs: 110,
  /** Idle roll oscillation, so the synthetic hand is not rigidly axis-aligned. */
  wobbleDeg: 6,
  wobbleMs: 2600,
  /** Handedness classification reported by the simulator. */
  handednessScore: 0.97,
  /** Handedness the simulator starts with; `H` toggles it. */
  defaultHandedness: 'Right',
} as const;

/** Replay harness constants (PLAN.md §13 M0, §21.4). */
export const REPLAY = {
  /** Loop the clip when it reaches the end. */
  loop: true,
  /** Frame rate used when a fixture omits `fps`. */
  fallbackFps: 24,
} as const;

/** Debug affordances. */
export const DEBUG = {
  /** Draw the FPS / source readout. */
  showHud: true,
  /** Draw the source-space corner markers that make mirroring obvious. */
  showSourceMarkers: true,
} as const;

/** How the input source is selected at startup. */
export const SOURCE_SELECTION = {
  /** `?source=mouse`, `?source=replay` or `?source=camera`. */
  queryParam: 'source',
  /** Used when the query parameter is absent or unrecognized. */
  defaultSource: 'mouse',
} as const;

/**
 * MediaPipe HandLandmarker configuration (PLAN.md §5, §7.3).
 *
 * `@mediapipe/tasks-vision` is pinned to an exact version in package.json. The
 * WASM bundle is copied out of that pinned package into `public/wasm/` by
 * `npm run assets:sync`, so the WASM and the JS can never drift apart. The
 * `.task` model is not on npm, so it is committed at `public/models/`.
 *
 * Verified against the installed 1.1.0 `vision.d.ts`:
 * - `detectForVideo(videoFrame, timestamp)` is SYNCHRONOUS and its second
 *   positional argument is named `timestamp` (ms).
 * - `delegate` must be nested inside `baseOptions`; top-level is a type error.
 * - `runningMode` accepts only `"IMAGE" | "VIDEO"` in the Web build. There is no
 *   `LIVE_STREAM` and no `detectAsync`, despite what the cross-platform docs and
 *   most tutorials imply.
 * - The result exposes `landmarks`, `worldLandmarks`, `handedness`
 *   (`handednesses` is deprecated), and each handedness entry is a `Category`
 *   with `{ categoryName, score, index, displayName }`.
 * - There is NO per-hand detection, presence or tracking confidence in the
 *   result. The `min*Confidence` values below are INPUTS ONLY (§5.1).
 */
export const MEDIAPIPE = {
  /** Self-hosted WASM bundle directory (PLAN.md §9: no CDN at runtime). */
  wasmBasePath: '/wasm',
  /** Self-hosted model, committed at public/models/ (PLAN.md §9). */
  modelAssetPath: '/models/hand_landmarker.task',

  /** §7.3 requires two hands. */
  numHands: 2,

  /**
   * Model input thresholds. These are CONFIGURATION, not observations: the model
   * never reports them back, and nothing in this codebase may present them as a
   * per-hand confidence (§5.1, §6.2).
   */
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,

  /** Preferred delegate; falls back to CPU when GPU init fails (§7.3). */
  preferredDelegate: 'GPU',

  /**
   * PLAN.md §8 handedness gotcha: MediaPipe's label is defined against a specific
   * mirroring assumption and a mirrored pipeline can invert it. Do NOT trust the
   * label until it has been checked on a real device by raising a known hand.
   * Set this to `true` only if that check shows the label inverted; it is the ONE
   * global swap, applied in exactly one place in `handTracker.ts`.
   *
   * Current value is `false` = unverified, no swap. See
   * docs/M1_DEVICE_TESTS.md for the verification procedure and
   * docs/TEST_MATRIX.md M1.2 for the open acceptance item.
   */
  swapHandedness: false,
} as const;

/**
 * Adaptive inference scheduling (PLAN.md §7.1).
 *
 * Inference frequency is NOT a success condition — sustained render FPS is.
 * These knobs bound how much of the frame budget inference is allowed to take.
 */
export const INFERENCE = {
  /** Floor, so the hand does not visibly freeze on a slow device. */
  minInferenceHz: 5,
  /** Ceiling; the scheduler never runs faster than the display. */
  maxInferenceHz: 30,
  /**
   * Share of a frame's budget inference may consume. The scheduler predicts the
   * next call's cost from a moving average and defers when it will not fit.
   */
  inferenceBudgetFraction: 0.5,
  /** Input resolution cap; raise only on desktop if measurements justify it (§7.3). */
  resolutionCap: 640,
  /** Weight of the newest sample in the cost moving average. */
  costEmaAlpha: 0.3,
  /** Cost assumed before anything has been measured, in ms. Deliberately pessimistic. */
  initialCostEstimateMs: 45,
  /**
   * §7.2: past this age the last detection stops being presented as current. The
   * hand is marked stale in the HUD rather than allowed to drift.
   */
  maxStalenessMs: 250,
  /**
   * §7.3 reliability: consecutive detect() throws that, together with
   * `failureWindowMs`, mean the detector is genuinely dead rather than stuttering.
   */
  maxConsecutiveFailures: 5,
  /** How long to wait for the worker to report that it is ready. Generous: it
   *  loads ~12 MB of WASM and a 7.5 MB model from scratch. */
  workerInitTimeoutMs: 30_000,
  /** How long to wait for one worker detection before treating it as lost. */
  workerDetectTimeoutMs: 5_000,
  /**
   * How long that failure streak must also *last* before the detector is given up
   * on.
   *
   * The count alone is too eager. A GPU context loss, a shader recompile or a long
   * GC pause can throw several times in a row and then recover, and disabling on
   * the count would end the session's camera for a transient fault — which is
   * indistinguishable, from the player's seat, from the app crashing.
   */
  failureWindowMs: 2_000,
} as const;

/**
 * Where hand detection runs (PLAN.md §7.3).
 *
 * - `main-thread` is the **measured baseline**: synchronous, ~9 ms of blocking per
 *   call, ~19 calls a second. It currently costs no frames on the target laptop, but
 *   it is 18% of wall time in a call that cannot yield.
 * - `worker` moves detection off the main thread, paid for with an `ImageBitmap`
 *   capture (~0.8 ms, async), a transfer each way, and landing in a later frame.
 *
 * **Defaults to the baseline.** PLAN.md §7.3 adopts a worker only if measurement says
 * it wins, so the unproven path is opt-in: `?inference=worker`, or this constant.
 */
export type DetectionMode = 'main-thread' | 'worker';

/**
 * The detection mode `main.ts` starts in. See {@link DetectionMode}.
 *
 * **Switched to `worker` on 2026-10-12** after the §7.3 A/B on the target laptop. The
 * main thread lost frames (p05 59.5 fps against the worker's 119.05) and blocked for
 * 1115 ms in a single `requestVideoFrameCallback`, while the worker reported **zero**
 * blocking. The worker's cost is +3.8 ms p50 latency for identical inference work.
 * `?inference=main-thread` restores the previous behaviour, which remains the tested
 * fallback. Full numbers in `docs/M1_WORKER_DECISION.md`.
 */
export const DETECTION_MODE: DetectionMode = 'worker';

/**
 * Hand identity association (PLAN.md §10).
 *
 * Distances are expressed as a fraction of the source's diagonal so the
 * thresholds behave the same at any capture resolution.
 */
export const IDENTITY = {
  /** Largest palm-center distance that can still match an existing identity. */
  maxMatchDistance: 0.25,
  /**
   * Added to the match cost when a detection's handedness contradicts an
   * identity's. Large enough to usually lose, small enough that a stale label
   * cannot lock out the correct identity.
   */
  handednessMismatchPenalty: 0.35,
  /** How long an unseen identity is held before it is declared lost (§10.3). */
  graceMs: 600,
  /**
   * When two palm centers are closer than this they are "crossing", and handedness
   * is preferred over position so the identities do not swap (§10.2).
   */
  crossingRadius: 0.18,
  /**
   * Below this separation, two detections in one frame are treated as **one physical
   * hand seen twice** rather than two hands.
   *
   * MediaPipe does emit duplicate boxes for a single hand — measured on a Pixel 10 Pro
   * XL at **0.014–0.020** apart (diagonal-normalized), mirrored, with *opposite*
   * handedness labels at high confidence. Both duplicates were previously adopted,
   * producing two independently-tracked hands and an unstable identity/colour.
   *
   * Deliberately much tighter than `maxMatchDistance` (0.25): that is a *matching*
   * radius, and using it as a duplicate radius suppresses genuinely separate hands.
   * 0.06 is roughly 48 px at 640x480 — several times the largest observed duplicate,
   * and far below `crossingRadius`, so normal two-hand play is unaffected.
   *
   * Two identities that are **both already live** are exempt, which is what keeps a
   * genuine crossing working: hands that were independently tracked last frame are
   * allowed to be this close.
   */
  duplicateHandRadius: 0.06,
  /** Report crossing counts in the debug HUD so swaps in playtest are diagnosable. */
  logCrossings: true,
} as const;

/** Camera capture (PLAN.md §13 M1). */
export const CAMERA = {
  facingMode: 'user',
  idealWidth: 640,
  idealHeight: 480,
  /**
   * Requested capture rate.
   *
   * This was **absent**, and the camera negotiated ~15 Hz on its own — measured
   * identically in both detection modes as a 67 ms frame-clock interval. That is what
   * caps how often the hand overlay and (in M3) the web aim can move, and it is
   * independent of where inference runs, so it looked like the worker had slowed
   * tracking down when it had not.
   *
   * `ideal` rather than `max`: a camera that cannot reach 30 Hz in poor light should
   * settle on the best it can do, not fail.
   */
  idealFrameRate: 30,
  /** How long to wait for `loadedmetadata` before giving up on the stream. */
  metadataTimeoutMs: 10_000,
  /**
   * How long to wait for `video.play()` to settle before treating it as stuck.
   *
   * A `play()` promise can simply never settle — for example when a policy is
   * waiting on an activation that will not arrive — and camera startup must not
   * hang on it.
   */
  playTimeoutMs: 8_000,
} as const;

/** On-device measurement harness (PLAN.md §7.3, §14.3). */
export const MEASUREMENT = {
  /** Rolling window summarised in the report. */
  windowMs: 120_000,
  /** How often the on-screen summary refreshes, in ms. */
  refreshMs: 500,
} as const;

/**
 * Web-gesture geometry and state machine (PLAN.md §11).
 *
 * **These thresholds are initial guesses from §11.2 and are NOT validated values.**
 * §11.2 requires tuning against real hands in M2; until that device work happens,
 * treat every number below as provisional. The debug HUD shows the live values and
 * the per-hand `gestureScore` precisely so they can be tuned from observation
 * rather than from this file.
 *
 * Geometry is normalized by hand span (§11.1), so the same numbers apply to an
 * adult and a child hand.
 */
export const GESTURE = {
  /** `dist(middleTip, palm) / span` below this: the middle finger counts as folded. */
  foldEnter: 0.35,
  /** Above this: definitely not folded. The gap is §11.3 hysteresis. */
  foldExit: 0.5,
  /** `dist(indexTip, wrist) / span` above this: the index counts as extended. */
  extEnter: 1.1,
  /** Below this: definitely not extended. The gap is §11.3 hysteresis. */
  extExit: 0.9,
  /** Minimum computed `gestureScore` for the state machine to arm (§11.4). */
  minGestureScore: 0.6,
  /** How long the pose must hold before it fires (§11.7). */
  holdMs: 150,
  /** Dead time after a fire, during which a held gesture cannot re-fire. */
  cooldownMs: 400,
  /**
   * After reacquisition, how long the hand must be observed *released* before it
   * may arm (§11.8). Stops a hand re-entering already in pose from firing at once.
   */
  rearmMs: 150,
  /**
   * Smoothing applied to the gesture score itself, so a pose hovering on the
   * `minGestureScore` boundary cannot chatter across it (§11.3).
   */
  scoreSmoothingAlpha: 0.35,
} as const;

/**
 * One Euro filter parameters (PLAN.md §11.6).
 *
 * Two copies exist per identity by design: **classify on the lightly-smoothed
 * stream, render from the heavily-smoothed one.** Classifying on the render filter
 * would add its lag to the gesture's reaction time; rendering from the light filter
 * would leave the visible hand jittery.
 *
 * §11.6 requires tuning; these are the plan's starting defaults.
 */
export const SMOOTHING = {
  /** Heavier smoothing, used for what the player sees. */
  render: { minCutoff: 1.5, beta: 0.01, dCutoff: 1.0 },
  /** Lighter smoothing, used for gesture classification (§11.6). */
  classify: { minCutoff: 4.0, beta: 0.02, dCutoff: 1.0 },
} as const;

/**
 * Joint-angle classifier constants (PLAN.md §11.5).
 *
 * **Unverified starting guesses**, exactly like the §11.2 distance thresholds above.
 * §11.5 asks for a geometry fallback and requires it to be validated on a real hand
 * before it is trusted; nothing here has been.
 *
 * The rationale for each is in `src/gesture/jointCurl.ts`. The short version: the
 * PIP joint angle is scale-free and position-free, so it does not depend on where
 * the palm centre lands or how large the hand is — which is what the distance method
 * is sensitive to, and which the first real playtest broke.
 */
export const JOINT = {
  /**
   * Interior PIP angle at or below which a finger is curled **on its own evidence**,
   * in degrees. 180 is perfectly straight.
   *
   * The gradient below this is deliberate and is the core of the design: a sharp
   * bend is conclusive, so it is believed without consulting the fingertip. The
   * fingertip is the least reliable landmark on a flexed finger — MediaPipe tends to
   * place it along an extended-curl prior, which is precisely the failure this
   * classifier exists to survive. Requiring corroboration from the tip even when the
   * joint evidence is unambiguous would re-import the bug being fixed.
   */
  curlStrongDeg: 100,
  /**
   * Interior PIP angle at or below which a finger is curled **if the chord also
   * agrees**, in degrees. Weak evidence needs support: at these angles a relaxed or
   * half-clenched hand looks similar to a deliberate press, so the chord ratio —
   * which is unaffected by where the palm centre sits — breaks the tie.
   */
  curlEnterDeg: 125,
  /** Above this a finger is definitely not curled. The gap is §11.3 hysteresis. */
  curlExitDeg: 145,
  /**
   * `|tip - mcp| / arc` at or below which a finger counts as folded back on itself.
   *
   * Consulted **only** in the `curlStrongDeg`–`curlEnterDeg` band. This is a
   * `tip`-derived measure, so it is treated as corroboration rather than truth.
   */
  chordEnterRatio: 0.72,
  chordExitRatio: 0.82,
  /**
   * Interior PIP angle at or above which index/pinky count as extended, in degrees.
   *
   * Deliberately the PIP joint **only**, never the DIP: the DIP angle is computed
   * from the fingertip, and extension is the requirement that keeps a fist from
   * reading as a gesture, so it must not depend on the flakiest landmark either.
   */
  extendEnterDeg: 150,
  extendExitDeg: 135,
  /**
   * Arms shorter than this fraction of hand span make a joint angle
   * ill-conditioned, because the angle would be built from numerical noise.
   * Triggers the distance fallback rather than a confident wrong answer.
   */
  minSegmentRatio: 0.12,
  /**
   * Finger arc shorter than this fraction of hand span means the finger points at
   * the camera. Detected explicitly so "foreshortened" is reported as such instead
   * of being silently misread.
   */
  minChainRatio: 0.35,
} as const;

/** Which pose classifier is active. The distance method stays the default (PLAN §11.5). */
export type GestureMethod = 'distance' | 'angle';

/**
 * The classifier used for gameplay.
 *
 * **Left at `'distance'` deliberately.** §11.5 requires the fallback to be validated
 * on a real hand before it is adopted, and it has not been. `?gesture=angle` selects
 * the joint-angle classifier per session, and the HUD reports both verdicts for the
 * same frame so they can be compared without changing this.
 */
export const GESTURE_METHOD: GestureMethod = 'distance';

/** How the classifier is chosen at startup. */
export const GESTURE_SELECTION = {
  /** `?gesture=distance` or `?gesture=angle`. */
  queryParam: 'gesture',
  /**
   * Rolling diagnostic observation buffer, in observations.
   *
   * At the measured ~4.7 Hz this holds roughly **32 seconds**, so it is deliberately *not* the
   * tuning dataset — a real labelled session runs for minutes and would evict its own early
   * takes. Saved takes are unbounded within `sessionFrameCapacity` instead.
   */
  captureFrames: 150,
  /**
   * Frames the saved-take dataset may hold.
   *
   * Generous on purpose: it exists to bound memory, not to decide what is kept. A four-minute run
   * of five poses with four repetitions is roughly 20 takes of a few observations each, far below
   * this.
   */
  sessionFrameCapacity: 2000,
  /**
   * How far back a take reaches from the tap.
   *
   * The player holds the pose, then taps, so the interesting evidence is the moment just before
   * the tap. 1.5 s spans about seven observations at the measured detection rate.
   */
  takeWindowMs: 1500,
  /**
   * How long the on-screen guidance tells the player to hold a pose before tapping.
   *
   * **Must be at least `takeWindowMs`**, and that invariant is enforced by a test. The window
   * reaches *back* from the tap, so holding for less than the window lets the take capture the
   * movement into the pose — which would label transition frames as the pose itself. The guidance
   * previously said "about a second" against a 1500 ms window, i.e. it invited exactly that.
   *
   * The margin matters too: a player cannot time a tap precisely, so the guidance is deliberately
   * longer than the bare minimum.
   */
  takeHoldGuidanceSeconds: 2,
} as const;

/**
 * Rendering between detections (PLAN.md §7.2).
 *
 * This is a **rendering technique only**. Interpolated positions are never fed to
 * the gesture classifier, never treated as observations, and never counted as
 * inference rate. §7.2 is explicit about all three.
 */
export const INTERPOLATION = {
  /**
   * Past this age the hand stops being advanced and is marked stale, so a lost
   * hand cannot drift across the screen (§7.2).
   */
  maxInterpolationAgeMs: 180,
  /** Advance landmarks for rendering between detections at all. */
  enabled: true,
} as const;

/**
 * Targets (PLAN.md §12.3).
 *
 * Positions are normalized video space, so the field does not care what the
 * capture resolution is. Spawn placement is deterministic from a seed, which is
 * what makes "fire at a target" testable without a browser or a camera.
 */
export const TARGETS = {
  /** Targets per round (PLAN.md §12.3: N targets spawn → clear → win). */
  perRound: 5,
  /** Radius in fraction of the source's shorter side, so it scales with resolution. */
  radiusFraction: 0.075,
  /** Keep spawn centers this far from the edge, so a target is never half-off-screen. */
  marginFraction: 0.10,
  /** Target-to-target spacing floor, so a field is not a clump. */
  minSeparationFraction: 0.16,
} as const;

/**
 * Aiming (PLAN.md §12.1).
 *
 * **Default: Model A — auto-aim**, deliberately forgiving because the primary
 * audience is a small child and the design goal is delight over difficulty.
 */
export const AIM = {
  /** Model A by default; Model B (point-to-aim) is the difficulty toggle. */
  model: 'auto' as 'auto' | 'point',
  /**
   * Half-angle of the cone in which a target is preferred, measured from the
   * hand's outward direction. Generous on purpose.
   */
  coneHalfAngleDeg: 55,
  /** Ignore targets closer to the palm than this; you cannot web your own face. */
  minDistanceFraction: 0.12,
  /** Aim vector for Model B: `normalize(indexTip - wrist)`. */
  pointModelToleranceDeg: 20,
} as const;

/** Web rendering and animation (PLAN.md §12.2). */
export const WEB = {
  /** Time for the web tip to travel from palm to impact. */
  travelMs: 120,
  /** Splat animation length at the impact point. */
  splatMs: 420,
  /** Web line width at zero distance, in source pixels. */
  baseLineWidthPx: 3,
  /** Additional line width at full distance, so far webs read as heavier. */
  distanceLineWidthPx: 5,
  /** Brighter, thinner core line drawn over the web, for the comic look. */
  coreLineWidthPx: 1.5,
  /** How far the Bézier control point sags below the chord, as a fraction of it. */
  sagFraction: 0.18,
  /** Radiating splat lines. */
  splatRays: 7,
  /** Maximum simultaneous webs drawn; the oldest are retired first. */
  maxLive: 12,
} as const;



