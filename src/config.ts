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
  /** Report crossing counts in the debug HUD so swaps in playtest are diagnosable. */
  logCrossings: true,
} as const;

/** Camera capture (PLAN.md §13 M1). */
export const CAMERA = {
  facingMode: 'user',
  idealWidth: 640,
  idealHeight: 480,
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

