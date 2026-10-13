/**
 * Joint-angle gesture recognition (PLAN.md §11.5).
 *
 * §11.5 anticipates exactly the failure the first real playtest hit:
 *
 * > The `middleToPalm` / `ringToPalm` distance check assumes the curled fingertip is
 * > near the palm regardless of hand orientation. [...] If the classifier fails
 * > reliably at any orientation, consider a geometry fallback (e.g. PIP joint angle)
 * > **rather than loosening the distance threshold.**
 *
 * The playtest measured middle/ring fingertip-to-palm at **0.7–1.6** against a
 * `foldEnter` of 0.35, with a gesture score of exactly **0.00** — i.e. the distances
 * were not marginal, they were outside the range entirely. The likely reason is that
 * a *flexed* fingertip is the hardest landmark for the model to place: under
 * self-occlusion the tip tends to be estimated along an extended-curl prior, so the
 * tip reads far from the palm even though the finger is plainly bent.
 *
 * The PIP joint bend does not have that problem. It is visible from the silhouette,
 * it is large at the angles that matter, and it is measured from *adjacent*
 * landmarks rather than from the palm centre — so it does not depend on where the
 * palm is or on how big the hand is.
 *
 * ---- Scope ----
 *
 * This module only *classifies*. It is not the default (see `GESTURE_METHOD` in
 * `config.ts`): the distance classifier stays in charge until real-device numbers
 * justify switching. `GestureController` can run both on the same frame so they can
 * be compared directly.
 *
 * The thresholds in `JOINT` are **unverified starting guesses**, exactly like the
 * §11.2 distance thresholds. Nothing here claims real-hand validation.
 */

import { GESTURE, JOINT } from '../config';
import { Landmark } from '../tracking/landmarkTypes';
import type { NormalizedLandmark, NormalizedPoint } from '../tracking/landmarkTypes';
import type { GestureGeometry, GesturePose } from './classifyGesture';
import { angleAtDeg, metricDistance, metricLength, polylineLength } from './geometry';

/** The four fingers this classifier cares about, in anatomical order. */
export type FingerName = 'index' | 'middle' | 'ring' | 'pinky';

/**
 * MediaPipe's index for each phalanx of a finger.
 *
 * MediaPipe numbers the chain MCP → PIP → DIP → TIP, which is the order the joints
 * bend in, so the interior angles at PIP and DIP are the flexion angles.
 */
export interface FingerChain {
  mcp: number;
  pip: number;
  dip: number;
  tip: number;
}

export const FINGER_CHAINS: Readonly<Record<FingerName, FingerChain>> = {
  index: { mcp: Landmark.INDEX_MCP, pip: Landmark.INDEX_PIP, dip: Landmark.INDEX_DIP, tip: Landmark.INDEX_TIP },
  middle: { mcp: Landmark.MIDDLE_MCP, pip: Landmark.MIDDLE_PIP, dip: Landmark.MIDDLE_DIP, tip: Landmark.MIDDLE_TIP },
  ring: { mcp: Landmark.RING_MCP, pip: Landmark.RING_PIP, dip: Landmark.RING_DIP, tip: Landmark.RING_TIP },
  pinky: { mcp: Landmark.PINKY_MCP, pip: Landmark.PINKY_PIP, dip: Landmark.PINKY_DIP, tip: Landmark.PINKY_TIP },
};

/** Which measurement decided a finger's curl, for diagnosis. */
export type CurlBasis =
  /** The PIP joint angle, the primary signal. */
  | 'angle'
  /** The angle was ill-conditioned, so the distance-to-palm test was used. */
  | 'distance-fallback'
  /** Neither was measurable; the finger is treated as not curled, fail-safe. */
  | 'unmeasurable';

export interface FingerMeasure {
  name: FingerName;
  /** Interior angle at the PIP joint in degrees; 180 is straight. */
  pipAngleDeg: number | null;
  /** Interior angle at the DIP joint in degrees. */
  dipAngleDeg: number | null;
  /** `|tip - mcp| / arc`. 1 for a straight finger, lower as it folds back. */
  chordRatio: number | null;
  /** `arc / span`. Small means the finger points at the camera (foreshortened). */
  chainRatio: number | null;
  /** True when the PIP angle is well-conditioned enough to trust. */
  reliable: boolean;
  /** True when the chord ratio is meaningful. */
  chordUsable: boolean;
  /** The classification before hysteresis. */
  curled: boolean;
  basis: CurlBasis;
}

export interface JointContext {
  aspect: number;
  /** Wrist-to-middle-MCP distance in metric units; the normalizer. */
  span: number;
}

/** Angle below which a finger counts as curled. `previous` selects the exit value. */
function curlEnterDeg(previousCurled: boolean): number {
  return previousCurled ? JOINT.curlExitDeg : JOINT.curlEnterDeg;
}

function chordEnterRatio(previousCurled: boolean): number {
  return previousCurled ? JOINT.chordExitRatio : JOINT.chordEnterRatio;
}

/**
 * Decide whether a finger is curled, from the PIP angle first and the chord only in
 * the ambiguous band.
 *
 * The gradient is the design. A sharp bend is conclusive; a moderate bend is not, and
 * only then is the chord consulted. The chord is derived from the fingertip, which is
 * the landmark most likely to be misplaced on a flexed finger, so it is never allowed
 * to *create* a curl or to overrule a strong one — only to arbitrate a borderline one.
 *
 * Exported so the gradient itself can be unit-tested directly, rather than only observed
 * through whole-hand fixtures.
 */
export function decideCurl(
  pipAngleDeg: number | null,
  chordRatio: number | null,
  chordUsable: boolean,
  previousCurled: boolean,
): { curled: boolean; basis: CurlBasis } {
  if (pipAngleDeg === null) return { curled: false, basis: 'unmeasurable' };

  if (pipAngleDeg <= JOINT.curlStrongDeg) return { curled: true, basis: 'angle' };

  const enter = curlEnterDeg(previousCurled);
  if (pipAngleDeg > enter) return { curled: false, basis: 'angle' };

  // Borderline: the joint evidence alone is not conclusive.
  if (!chordUsable || chordRatio === null) {
    // No corroboration available, so the safe answer is "not curled". A missed
    // gesture is recoverable by re-posing; a phantom fire is not.
    return { curled: false, basis: 'angle' };
  }
  return { curled: chordRatio <= chordEnterRatio(previousCurled), basis: 'angle' };
}

/**
 * Measure one finger and decide whether it is curled.
 *
 * The decision order matters and is the whole point of the module:
 *
 * 1. **PIP angle** (`reliable`) — primary. Scale-free and position-free.
 * 2. **Chord ratio** — corroboration, applied only when the finger is long enough
 *    in frame for the ratio to mean anything. Both a sharp bend *and* a shortened
 *    chord is what a genuinely folded finger looks like; a relaxed finger has a
 *    moderate bend but its chord stays near the arc.
 * 3. **Distance-to-palm fallback** — only when the angle is ill-conditioned, i.e.
 *    the finger points at the camera and its phalanges project to almost nothing.
 *    This is §11.5's "geometry fallback", used where the angle cannot work instead
 *    of loosening a threshold.
 */
export function measureFinger(
  landmarks: readonly NormalizedLandmark[],
  name: FingerName,
  context: JointContext,
  previousCurled: boolean,
  palmCenter: NormalizedPoint,
): FingerMeasure {
  const chain = FINGER_CHAINS[name];
  const mcp = landmarks[chain.mcp];
  const pip = landmarks[chain.pip];
  const dip = landmarks[chain.dip];
  const tip = landmarks[chain.tip];

  const empty: FingerMeasure = {
    name,
    pipAngleDeg: null,
    dipAngleDeg: null,
    chordRatio: null,
    chainRatio: null,
    reliable: false,
    chordUsable: false,
    curled: false,
    basis: 'unmeasurable',
  };
  if (!mcp || !pip || !dip || !tip) return empty;

  const aspect = context.aspect;
  const span = context.span;

  const pipAngleDeg = angleAtDeg(mcp, pip, dip, aspect);
  const dipAngleDeg = angleAtDeg(pip, dip, tip, aspect);

  const armA = metricDistance(mcp, pip, aspect);
  const armB = metricDistance(pip, dip, aspect);
  const arc = polylineLength([mcp, pip, dip, tip], aspect);
  const chord = metricDistance(mcp, tip, aspect);

  const chainRatio = span > 0 ? arc / span : null;
  const chordRatio = arc > 1e-9 ? chord / arc : null;

  // An angle needs two non-degenerate arms. Measuring this directly — rather than
  // trusting that the landmarks "look fine" — is what stops a foreshortened finger
  // from reporting a confident bend built from numerical noise.
  const shortestArm = Math.min(armA, armB);
  const reliable =
    span > 0 && pipAngleDeg !== null && shortestArm / span >= JOINT.minSegmentRatio;
  const chordUsable =
    chordRatio !== null && chainRatio !== null && chainRatio >= JOINT.minChainRatio;

  const distanceSaysCurled =
    metricDistance(tip, palmCenter, aspect) / (span > 0 ? span : 1) <
    (previousCurled ? GESTURE.foldExit : GESTURE.foldEnter);

  const curlDecision = reliable
    ? decideCurl(pipAngleDeg, chordRatio, chordUsable, previousCurled)
    : distanceSaysCurled
      ? { curled: true, basis: 'distance-fallback' as CurlBasis }
      : {
          curled: false,
          basis: (chainRatio === null ? 'unmeasurable' : 'distance-fallback') as CurlBasis,
        };

  return {
    name,
    pipAngleDeg,
    dipAngleDeg,
    chordRatio,
    chainRatio,
    reliable,
    chordUsable,
    curled: curlDecision.curled,
    basis: curlDecision.basis,
  };
}

/**
 * Straightness of an extended finger, from the **PIP joint only**.
 *
 * Deliberately not the DIP: that angle is computed from the fingertip, and extension
 * is the check that stops a fist from reading as the gesture, so it must not depend
 * on the least reliable landmark either (PLAN.md §11.5).
 */
function straightnessDeg(measure: FingerMeasure): number | null {
  return measure.pipAngleDeg;
}

/**
 * Classify the whole hand by joint angles (PLAN.md §11.5).
 *
 * Same output shape as the distance classifier so it is a drop-in alternative, and
 * so `GestureController` can run both on one frame and report both verdicts.
 *
 * The gesture is unchanged: **index and pinky extended, middle and ring folded.**
 */
export interface JointClassification {
  measures: Record<FingerName, FingerMeasure>;
  pose: GesturePose;
  score: number;
  /** Fraction of fingers whose curl was decided by a trustworthy PIP angle. */
  reliableFraction: number;
}

export function classifyGestureByJoints(
  landmarks: readonly NormalizedLandmark[],
  previous: GesturePose | null,
  aspect: number,
  span: number,
  palmCenter: NormalizedPoint,
): JointClassification {
  const context: JointContext = { aspect, span };
  /**
   * Hysteresis seed for the curl decision.
   *
   * Only middle and ring are gated on curl. Index and pinky are judged on
   * *extension* (see `extendedByAngle`), whose hysteresis comes from the previous
   * pose's `extended` flag instead — so their curl value is diagnostic only and the
   * seed is irrelevant to the verdict.
   */
  const previousCurled = (name: FingerName): boolean =>
    name === 'middle' || name === 'ring' ? (previous?.folded ?? false) : false;

  const measures = {
    index: measureFinger(landmarks, 'index', context, false, palmCenter),
    middle: measureFinger(landmarks, 'middle', context, previousCurled('middle'), palmCenter),
    ring: measureFinger(landmarks, 'ring', context, previousCurled('ring'), palmCenter),
    pinky: measureFinger(landmarks, 'pinky', context, false, palmCenter),
  } as Record<FingerName, FingerMeasure>;

  // §4 requirement preserved: index and pinky must be EXTENDED for the gesture.
  // Straightness is judged on the angle when it is trustworthy, and otherwise by
  // the distance fallback that has always been used — so this cannot become *more*
  // permissive than before by accident.
  const sustained = previous?.extended ?? false;
  const extendedByAngle = (name: 'index' | 'pinky'): boolean => {
    const measure = measures[name];
    const straight = straightnessDeg(measure);
    if (measure.reliable && straight !== null) {
      return straight >= (sustained ? JOINT.extendExitDeg : JOINT.extendEnterDeg);
    }
    return false;
  };

  const indexExtended = extendedByAngle('index');
  const pinkyExtended = extendedByAngle('pinky');

  const folded = measures.middle.curled && measures.ring.curled;
  const extended = indexExtended && pinkyExtended;

  const usable = [measures.index, measures.middle, measures.ring, measures.pinky].filter(
    (measure) => measure.reliable,
  ).length;

  return {
    measures,
    pose: { folded, extended, isGesture: folded && extended },
    score: jointGestureScore(measures),
    reliableFraction: usable / 4,
  };
}

function foldAngleExcess(pipAngleDeg: number | null): number {
  if (pipAngleDeg === null) return 0;
  const span = JOINT.curlExitDeg - JOINT.curlEnterDeg;
  if (span <= 0) return 0;
  return clamp01((JOINT.curlExitDeg - pipAngleDeg) / span);
}

function extendAngleExcess(straight: number | null): number {
  if (straight === null) return 0;
  const span = JOINT.extendEnterDeg - JOINT.extendExitDeg;
  if (span <= 0) return 0;
  return clamp01((straight - JOINT.extendExitDeg) / span);
}

/**
 * Computed heuristic in `[0,1]`, mirroring §11.4's structure (PLAN.md §11.4).
 *
 * As with the distance method it is the **weakest** of the four conditions, so it
 * rises monotonically as the pose improves and cannot be satisfied by one finger
 * alone. It is a game-computed value, never a model confidence (§6.2).
 */
export function jointGestureScore(measures: Record<FingerName, FingerMeasure>): number {
  return Math.min(
    foldAngleExcess(measures.middle.pipAngleDeg),
    foldAngleExcess(measures.ring.pipAngleDeg),
    extendAngleExcess(straightnessDeg(measures.index)),
    extendAngleExcess(straightnessDeg(measures.pinky)),
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Aspect-corrected palm centre, for callers that only have landmarks. */
export function palmCenterOf(landmarks: readonly NormalizedLandmark[]): NormalizedPoint | null {
  const indices = [
    Landmark.WRIST,
    Landmark.INDEX_MCP,
    Landmark.MIDDLE_MCP,
    Landmark.RING_MCP,
    Landmark.PINKY_MCP,
  ];
  let x = 0;
  let y = 0;
  for (const index of indices) {
    const point = landmarks[index];
    if (!point) return null;
    x += point.x;
    y += point.y;
  }
  return { x: x / indices.length, y: y / indices.length };
}

/** Distance-based geometry, widened to carry the aspect the metrics need. */
export function spanOf(landmarks: readonly NormalizedLandmark[], aspect: number): number {
  const wrist = landmarks[Landmark.WRIST];
  const middleMcp = landmarks[Landmark.MIDDLE_MCP];
  if (!wrist || !middleMcp) return 0;
  return metricLength((middleMcp.x - wrist.x) * aspect, middleMcp.y - wrist.y);
}

/** Re-exported so a caller can build a `GestureGeometry` from joint context. */
export type { GestureGeometry };
