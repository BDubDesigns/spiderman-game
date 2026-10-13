/**
 * Web-gesture classification (PLAN.md §11).
 *
 * The gesture: **index and pinky extended; middle and ring folded to the palm.**
 *
 * Everything here is normalized by hand span (§11.1) so an adult hand and a
 * child's hand classify identically. Nothing keys on array position, and nothing
 * consumes a model confidence: `gestureScore` is a **computed heuristic**, not a
 * model output (§11.4, §6.2).
 *
 * Pure: no DOM, no canvas, no MediaPipe, so the whole policy is unit-tested.
 */

import { GESTURE } from '../config';
import { Landmark } from '../tracking/landmarkTypes';
import type { NormalizedLandmark, NormalizedPoint } from '../tracking/landmarkTypes';

/** Landmarks whose centroid is the palm, matching §11.1 and `handIdentity`. */
const PALM_LANDMARKS = [
  Landmark.WRIST,
  Landmark.INDEX_MCP,
  Landmark.MIDDLE_MCP,
  Landmark.RING_MCP,
  Landmark.PINKY_MCP,
] as const;

/**
 * Per-finger measurements, all in units of hand span (§11.1).
 *
 * `middleToPalm` / `ringToPalm` fall as those fingers curl; `indexExt` /
 * `pinkyExt` rise as those fingers straighten.
 */
export interface GestureGeometry {
  /** `dist(wrist, middleMCP)` — the normalizer. Zero means unmeasurable. */
  span: number;
  middleToPalm: number;
  ringToPalm: number;
  indexExt: number;
  pinkyExt: number;
}

/** Raw pose classification, before hysteresis or scoring. */
export interface GesturePose {
  /** Both curling fingers are inside the fold threshold. */
  folded: boolean;
  /** Both straight fingers are past the extend threshold. */
  extended: boolean;
  /** The pose is the gesture. */
  isGesture: boolean;
}

export function distance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Landmark accessor that tolerates a short array rather than throwing. */
function landmarkAt(
  landmarks: readonly NormalizedLandmark[],
  index: number,
): NormalizedLandmark | null {
  return landmarks[index] ?? null;
}

/**
 * Compute the §11.1 geometry, or `null` when it cannot be measured.
 *
 * `null` rather than zeros: a degenerate span would otherwise make every ratio
 * `Infinity`/`NaN` and could be scored as a confident gesture.
 */
export function gestureGeometry(
  landmarks: readonly NormalizedLandmark[],
): GestureGeometry | null {
  if (landmarks.length < 21) return null;

  const wrist = landmarkAt(landmarks, Landmark.WRIST);
  const middleMcp = landmarkAt(landmarks, Landmark.MIDDLE_MCP);
  const middleTip = landmarkAt(landmarks, Landmark.MIDDLE_TIP);
  const ringTip = landmarkAt(landmarks, Landmark.RING_TIP);
  const indexTip = landmarkAt(landmarks, Landmark.INDEX_TIP);
  const pinkyTip = landmarkAt(landmarks, Landmark.PINKY_TIP);
  if (!wrist || !middleMcp || !middleTip || !ringTip || !indexTip || !pinkyTip) {
    return null;
  }

  // §11.1: wrist -> middle MCP is stable and usually visible, which is why it is
  // the normalizer rather than, say, the bounding box.
  const span = distance(wrist, middleMcp);
  if (!(span > 1e-6)) return null;

  let sumX = 0;
  let sumY = 0;
  for (const index of PALM_LANDMARKS) {
    const point = landmarkAt(landmarks, index);
    if (!point) return null;
    sumX += point.x;
    sumY += point.y;
  }
  const palm: NormalizedPoint = {
    x: sumX / PALM_LANDMARKS.length,
    y: sumY / PALM_LANDMARKS.length,
  };

  return {
    span,
    middleToPalm: distance(middleTip, palm) / span,
    ringToPalm: distance(ringTip, palm) / span,
    indexExt: distance(indexTip, wrist) / span,
    pinkyExt: distance(pinkyTip, wrist) / span,
  };
}

/**
 * Classify the pose with §11.3 hysteresis.
 *
 * `previous` is the last classification for **this identity**, and is what makes
 * the thresholds asymmetric: a finger already folded must exceed `foldExit` to
 * become unfolded, and vice versa. Without it, a measure sitting exactly on a
 * threshold would flip every frame and the state machine would chatter.
 */
export function classifyPose(
  geometry: GestureGeometry,
  previous: GesturePose | null,
): GesturePose {
  const middleFolded = geometry.middleToPalm < (previous?.folded ? GESTURE.foldExit : GESTURE.foldEnter);
  const ringFolded = geometry.ringToPalm < (previous?.folded ? GESTURE.foldExit : GESTURE.foldEnter);
  const indexExtended =
    geometry.indexExt > (previous?.extended ? GESTURE.extExit : GESTURE.extEnter);
  const pinkyExtended =
    geometry.pinkyExt > (previous?.extended ? GESTURE.extExit : GESTURE.extEnter);

  const folded = middleFolded && ringFolded;
  const extended = indexExtended && pinkyExtended;

  return { folded, extended, isGesture: folded && extended };
}

/**
 * How far past the thresholds the pose is, in `[0,1]` (§11.4).
 *
 * A **computed heuristic**, never a model confidence, and never to be labelled as
 * one. Each of the four conditions contributes a normalized excess, and the score
 * is the weakest of them — a chain of four conditions is only as good as its worst
 * link, which is also what makes the score monotone as the pose improves.
 */
export function gestureScore(geometry: GestureGeometry): number {
  const foldExcess = (value: number): number =>
    clamp01((GESTURE.foldExit - value) / (GESTURE.foldExit - GESTURE.foldEnter || 1));
  const extendExcess = (value: number): number =>
    clamp01((value - GESTURE.extExit) / (GESTURE.extEnter - GESTURE.extExit || 1));

  return Math.min(
    foldExcess(geometry.middleToPalm),
    foldExcess(geometry.ringToPalm),
    extendExcess(geometry.indexExt),
    extendExcess(geometry.pinkyExt),
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** The complete classification for one hand in one frame. */
export interface GestureClassification {
  geometry: GestureGeometry | null;
  pose: GesturePose;
  score: number;
}

const NEUTRAL_POSE: GesturePose = { folded: false, extended: false, isGesture: false };

/**
 * Classify one hand's landmarks.
 *
 * Returns a non-gesture classification for unusable input rather than `null`, so
 * callers have a single shape to reason about: an unmeasurable hand is simply not
 * gesturing, and it must never be mistaken for a confident one.
 */
export function classifyGesture(
  landmarks: readonly NormalizedLandmark[],
  previous: GesturePose | null = null,
): GestureClassification {
  const geometry = gestureGeometry(landmarks);
  if (geometry === null) {
    return { geometry: null, pose: NEUTRAL_POSE, score: 0 };
  }
  return {
    geometry,
    pose: classifyPose(geometry, previous),
    score: gestureScore(geometry),
  };
}
