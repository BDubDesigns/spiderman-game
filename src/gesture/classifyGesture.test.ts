/**
 * Unit tests for the web-gesture classifier (PLAN.md §11), covering the M2 `[A]`
 * criterion: "Unit tests for `classifyGesture` against a fixture set covering
 * folded/extended/ambiguous poses".
 *
 * The fixtures are built so the four §11.1 measurements land on *exact* requested
 * values, which keeps each test about the policy rather than about arithmetic.
 * Span is normalized to 1 by placing the wrist at the origin and the middle MCP at
 * `(0, 1)`, so every ratio below reads directly as a distance.
 */

import { describe, expect, it } from 'vitest';

import { GESTURE } from '../config';
import { LANDMARK_COUNT, Landmark } from '../tracking/landmarkTypes';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';
import {
  classifyGesture,
  classifyPose,
  gestureGeometry,
  gestureScore,
  type GesturePose,
} from './classifyGesture';

const WRIST = { x: 0, y: 0 };
const MIDDLE_MCP = { x: 0, y: 1 };
const INDEX_MCP = { x: -0.3, y: 0.9 };
const RING_MCP = { x: 0.3, y: 0.9 };
const PINKY_MCP = { x: 0.6, y: 1.0 };

/** The palm centroid of the fixed MCP scaffold above. */
const PALM = {
  x: (WRIST.x + INDEX_MCP.x + MIDDLE_MCP.x + RING_MCP.x + PINKY_MCP.x) / 5,
  y: (WRIST.y + INDEX_MCP.y + MIDDLE_MCP.y + RING_MCP.y + PINKY_MCP.y) / 5,
};

interface PoseSpec {
  /** `dist(middleTip, palm)` — small means folded. */
  middle: number;
  /** `dist(ringTip, palm)` — small means folded. */
  ring: number;
  /** `dist(indexTip, wrist)` — large means extended. */
  index: number;
  /** `dist(pinkyTip, wrist)` — large means extended. */
  pinky: number;
}

/**
 * Build a 21-landmark hand whose four §11.1 measurements are exactly the spec's.
 *
 * Tips are placed along axes from the palm or wrist, so the distance is the value.
 */
function hand(spec: PoseSpec): NormalizedLandmark[] {
  const points: NormalizedLandmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({
    x: PALM.x,
    y: PALM.y,
  }));
  points[Landmark.WRIST] = { ...WRIST };
  points[Landmark.INDEX_MCP] = { ...INDEX_MCP };
  points[Landmark.MIDDLE_MCP] = { ...MIDDLE_MCP };
  points[Landmark.RING_MCP] = { ...RING_MCP };
  points[Landmark.PINKY_MCP] = { ...PINKY_MCP };

  points[Landmark.MIDDLE_TIP] = { x: PALM.x, y: PALM.y - spec.middle };
  points[Landmark.RING_TIP] = { x: PALM.x + spec.ring, y: PALM.y };
  points[Landmark.INDEX_TIP] = { x: 0, y: -spec.index };
  points[Landmark.PINKY_TIP] = { x: 0, y: -spec.pinky };

  return points;
}

/** The gesture: middle and ring folded in, index and pinky out. */
const GESTURE_POSE: PoseSpec = { middle: 0.2, ring: 0.25, index: 1.4, pinky: 1.3 };
/** An open hand: nothing folded. */
const OPEN_HAND: PoseSpec = { middle: 0.8, ring: 0.85, index: 1.5, pinky: 1.4 };
/** A fist: everything folded. */
const FIST: PoseSpec = { middle: 0.15, ring: 0.2, index: 0.5, pinky: 0.45 };
/** Index and pinky out, but only the middle folded — half the gesture. */
const HALF_FOLDED: PoseSpec = { middle: 0.2, ring: 0.8, index: 1.4, pinky: 1.3 };

describe('gestureGeometry (§11.1)', () => {
  it('normalizes every measurement by the wrist-to-middle-MCP span', () => {
    const geometry = gestureGeometry(hand(GESTURE_POSE))!;
    expect(geometry.span).toBeCloseTo(1, 12);
    expect(geometry.middleToPalm).toBeCloseTo(0.2, 12);
    // The ring tip is offset **horizontally** in this fixture, so the aspect
    // correction scales it: 0.25 * 4/3. Before the fix this read 0.25, because the
    // distance was a bare hypot over two axes normalized by different dimensions.
    expect(geometry.ringToPalm).toBeCloseTo(0.25 * (4 / 3), 12);
    expect(geometry.indexExt).toBeCloseTo(1.4, 12);
    expect(geometry.pinkyExt).toBeCloseTo(1.3, 12);
    expect(geometry.spanAspect).toBeCloseTo(4 / 3, 12);
  });

  it('scales with hand size, so an adult and a child hand classify alike', () => {
    // Same pose at 60% scale: every ratio must be identical.
    const scale = 0.6;
    const big = gestureGeometry(hand(GESTURE_POSE))!;
    const small = gestureGeometry(
      hand(GESTURE_POSE).map((p) => ({ x: p.x * scale, y: p.y * scale })),
    )!;

    expect(small.span).toBeCloseTo(big.span * scale, 12);
    expect(small.middleToPalm).toBeCloseTo(big.middleToPalm, 12);
    expect(small.ringToPalm).toBeCloseTo(big.ringToPalm, 12);
    expect(small.indexExt).toBeCloseTo(big.indexExt, 12);
    expect(small.pinkyExt).toBeCloseTo(big.pinkyExt, 12);
  });

  it('returns null for an incomplete hand rather than a misleading pose', () => {
    expect(gestureGeometry(hand(GESTURE_POSE).slice(0, 12))).toBeNull();
  });

  it('returns null for a degenerate span instead of dividing by zero', () => {
    const collapsed = hand(GESTURE_POSE);
    collapsed[Landmark.MIDDLE_MCP] = { ...WRIST };
    expect(gestureGeometry(collapsed)).toBeNull();
  });
});

describe('classifyGesture — folded, extended and ambiguous poses', () => {
  it('classifies the web gesture', () => {
    const result = classifyGesture(hand(GESTURE_POSE));
    expect(result.pose.folded).toBe(true);
    expect(result.pose.extended).toBe(true);
    expect(result.pose.isGesture).toBe(true);
  });

  it('does not classify an open hand', () => {
    const result = classifyGesture(hand(OPEN_HAND));
    expect(result.pose.folded).toBe(false);
    expect(result.pose.isGesture).toBe(false);
  });

  it('does not classify a fist', () => {
    const result = classifyGesture(hand(FIST));
    expect(result.pose.folded).toBe(true);
    expect(result.pose.extended).toBe(false);
    expect(result.pose.isGesture).toBe(false);
  });

  it('does not classify a half-folded hand', () => {
    // Ring still out: the pose is close but not the gesture, so it must not fire.
    const result = classifyGesture(hand(HALF_FOLDED));
    expect(result.pose.folded).toBe(false);
    expect(result.pose.isGesture).toBe(false);
  });

  it('treats an unusable hand as not gesturing, never as confident', () => {
    const result = classifyGesture([]);
    expect(result.geometry).toBeNull();
    expect(result.pose.isGesture).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe('classifyGesture — hysteresis (§11.3)', () => {
  const OPEN: GesturePose = { folded: false, extended: false, isGesture: false };

  it('keeps a finger folded until it passes the wider foldExit threshold', () => {
    // The ring tip's horizontal offset is aspect-scaled, so a raw 0.30 reads as 0.40
    // — inside the foldEnter (0.35) to foldExit (0.50) band. Values chosen for the
    // band, not for the raw number.
    const inBand = hand({ ...GESTURE_POSE, middle: 0.42, ring: 0.3 });

    // Coming from open, 0.42 is not yet folded.
    expect(classifyPose(gestureGeometry(inBand)!, OPEN).folded).toBe(false);

    // Coming from folded, the same measurement stays folded.
    const FOLDED: GesturePose = { folded: true, extended: true, isGesture: true };
    expect(classifyPose(gestureGeometry(inBand)!, FOLDED).folded).toBe(true);
  });

  it('keeps a finger extended until it drops below extExit', () => {
    // 1.0 is below extEnter (1.10) but above extExit (0.90).
    const inBand = hand({ ...GESTURE_POSE, index: 1.0, pinky: 1.0 });
    const EXTENDED: GesturePose = { folded: true, extended: true, isGesture: true };

    expect(classifyPose(gestureGeometry(inBand)!, EXTENDED).extended).toBe(true);
    expect(classifyPose(gestureGeometry(inBand)!, OPEN).extended).toBe(false);
  });

  it('does not flicker when a measurement sits exactly on a threshold', () => {
    // Alternating either side of foldEnter with no previous state must be stable
    // in the sense that the *same* input always yields the same output.
    const onThreshold = hand({ ...GESTURE_POSE, middle: GESTURE.foldEnter, ring: GESTURE.foldEnter });
    const geometry = gestureGeometry(onThreshold)!;
    const first = classifyPose(geometry, null);
    const second = classifyPose(geometry, first);
    expect(second).toEqual(first);
  });
});

describe('gestureScore (§11.4)', () => {
  it('scores a clean gesture at 1', () => {
    expect(gestureScore(gestureGeometry(hand(GESTURE_POSE))!)).toBeCloseTo(1, 12);
  });

  it('scores an open hand at 0', () => {
    expect(gestureScore(gestureGeometry(hand(OPEN_HAND))!)).toBeCloseTo(0, 12);
  });

  it('scores inside the hysteresis band below the arming minimum', () => {
    // The pose still classifies as extended (1.0 > extExit 0.90) but its weakest
    // link is only half-satisfied, so it must not clear MIN_GESTURE_SCORE.
    const inBand = hand({ ...GESTURE_POSE, index: 1.0, pinky: 1.0 });
    const score = gestureScore(gestureGeometry(inBand)!);

    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(GESTURE.minGestureScore);
  });

  it('is the weakest of the four conditions, so it rises monotonically', () => {
    const weak = gestureScore(gestureGeometry(hand({ ...GESTURE_POSE, index: 0.95 }))!);
    const stronger = gestureScore(gestureGeometry(hand({ ...GESTURE_POSE, index: 1.05 }))!);
    const clean = gestureScore(gestureGeometry(hand(GESTURE_POSE))!);

    expect(weak).toBeLessThanOrEqual(stronger);
    expect(stronger).toBeLessThanOrEqual(clean);
  });
});
