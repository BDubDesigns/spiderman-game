/**
 * Raw tracking types for Web Slinger.
 *
 * These types are OURS. They deliberately do not import MediaPipe types, so that
 * `tracking/` and `sim/` stay pure (PLAN.md §6.1) and so the real tracker, the
 * replay harness and the mouse simulator can all satisfy one contract with the
 * same game code unchanged.
 *
 * ---- Model-output discipline (PLAN.md §5.1, §6.2, §10.4) ----
 *
 * The model exposes exactly two things we consume:
 *
 *   1. `landmarks`      — 21 normalized points per hand
 *   2. `handedness`     — a classification of `{ label, score }` per hand
 *
 * It does NOT expose per-hand detection, presence or tracking confidence. The
 * `minHandDetectionConfidence` / `minHandPresenceConfidence` /
 * `minTrackingConfidence` values in the model options are **configuration
 * inputs**, not observable outputs. There are therefore no
 * `apiDetectionConfidence`-style fields in this file, and none may be added.
 *
 * Any continuity, identity-match, gesture or staleness value is a
 * **game-computed heuristic** derived from observations. Those live outside this
 * file and are named so they cannot be mistaken for model output
 * (`gestureScore`, `identityMatchScore`, `staleness`).
 */

/**
 * MediaPipe hand landmark indices, in the model's documented order.
 *
 * Named here because raw numeric indices in geometry code are unreadable and a
 * mis-indexed finger is a silent bug. The order (wrist, then thumb..pinky, each
 * proximal -> distal) matches the 21-point hand model.
 */
export const Landmark = {
  WRIST: 0,

  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,

  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,

  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,

  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,

  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

/** Union of the valid landmark indices. */
export type LandmarkIndex = (typeof Landmark)[keyof typeof Landmark];

/** The model's fixed landmark count per hand. */
export const LANDMARK_COUNT = 21;

/**
 * A single normalized landmark, in **video space**.
 *
 * PLAN.md §8:
 * - `x` is `[0,1]` across the source's intrinsic width, origin at the **left**,
 *   as captured and therefore **unmirrored**. Mirroring happens exactly once, in
 *   `toCanvas()`.
 * - `y` is `[0,1]` down the source's intrinsic height, origin at the top.
 * - `z` is the model's raw relative depth passthrough. **PLAN.md §8 Rule C:
 *   never use `z` for screen position in v1.** It is retained only so the real
 *   tracker can hand through the model's output unchanged. Nothing reads it.
 */
export interface NormalizedLandmark {
  x: number;
  y: number;
  z?: number;
}

/** A handedness label as reported by the model. PLAN.md §8 documents that this
 *  label may need one documented global swap after empirical M1 verification. */
export type HandednessLabel = 'Left' | 'Right';

/**
 * The model's handedness classification for one hand.
 *
 * `score` is a genuine model output, unlike the game-computed heuristics
 * described in the file header.
 */
export interface Handedness {
  label: HandednessLabel;
  score: number;
}

/** One hand, as observed in one frame. */
export interface RawHandFrame {
  /** Exactly `LANDMARK_COUNT` entries, in model order. */
  landmarks: NormalizedLandmark[];
  handedness: Handedness;
}

/**
 * Where a frame's data came from.
 *
 * This exists to keep PLAN.md §7.2 honest: positions advanced between detections
 * are a rendering technique, NOT tracking information, and must never reach the
 * gesture classifier or be counted as inference.
 */
export type FrameProvenance =
  /** Produced by a real detector on a real frame. */
  | 'observed'
  /** Advanced between detections for rendering only (§7.2). Never classify these. */
  | 'interpolated'
  /** Produced by a simulator or replay fixture, not by a detector. */
  | 'simulated';

/** One frame of hand data from any source. */
export interface RawFrame {
  /** Monotonic timestamp on the render loop's clock, in ms. */
  timestampMs: number;
  /** Detected hands. Order is NOT meaningful — never key state on array index
   *  (PLAN.md §10). Identity association is M1 work. */
  hands: RawHandFrame[];
  /** Which source produced this frame, for the debug HUD. */
  sourceId: string;
  provenance: FrameProvenance;
}

/**
 * The one interface every hand-data source implements.
 *
 * This is the seam that makes the M0 harness worth having: `ReplaySource`,
 * `MouseSource`, and (from M1) the real camera-backed tracker all satisfy this
 * contract, so game code consuming it cannot tell them apart. That is what makes
 * the simulator a real fallback rather than a demo (PLAN.md §13 M0, §16.3).
 *
 * `frameAt()` is pulled by the render loop rather than pushed, which keeps the
 * source free of timers and DOM and keeps render decoupled from any inference
 * loop (PLAN.md §7.1).
 */
export interface HandFrameSource {
  /** Stable identifier, surfaced in the debug HUD. */
  readonly id: string;
  /** Provenance reported on every frame this source emits. */
  readonly provenance: FrameProvenance;
  /** Begin producing frames. `nowMs` is the render loop's monotonic clock. */
  start(nowMs: number): void;
  /** Stop producing frames. `frameAt()` must return `null` until restarted. */
  stop(): void;
  /**
   * The frame for this instant, or `null` if no frame is available.
   *
   * Implementations may advance internal animation state, so `nowMs` must be
   * monotonically non-decreasing. The same `nowMs` with unchanged inputs must
   * yield the same frame, which is what makes these sources unit-testable
   * without a browser.
   */
  frameAt(nowMs: number): RawFrame | null;
}

/** True when a hand carries the full 21 landmarks. */
export function isCompleteHand(hand: RawHandFrame): boolean {
  return hand.landmarks.length === LANDMARK_COUNT;
}
