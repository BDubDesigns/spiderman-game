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
  /** `?source=mouse` or `?source=replay`. */
  queryParam: 'source',
  /** Used when the query parameter is absent or unrecognized. */
  defaultSource: 'mouse',
} as const;
