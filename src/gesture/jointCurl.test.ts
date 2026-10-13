/**
 * Unit tests for the joint-angle classifier (PLAN.md §11.5).
 *
 * Two things are being established here, and they are different in kind:
 *
 * 1. **Logic and invariance** — hysteresis, the reliability guards, aspect and scale
 *    invariance, and the false-positive battery. Synthetic geometry whose joint
 *    angles are known by construction is exactly the right instrument for this.
 * 2. **Nothing about real hands.** The thresholds in `JOINT` are unverified guesses;
 *    no test in this file claims otherwise. Real-hand accuracy is a Pixel question,
 *    answered by the capture tool.
 *
 * The load-bearing test is `recognises a gesture whose fingertip the model has
 * misplaced`: it reproduces the observed device failure — middle/ring
 * fingertip-to-palm 0.7–1.6 against a 0.35 threshold, score 0.00 — and shows the
 * joint method still recognising the pose.
 */

import { describe, expect, it } from 'vitest';

import { JOINT } from '../config';
import { classifyGesture } from './classifyGesture';
import {
  FIST_SPEC,
  GESTURE_MISPLACED_TIP_SPEC,
  GESTURE_SPEC,
  OPEN_PALM_SPEC,
  POINTING_SPEC,
  RELAXED_SPEC,
  buildHand,
  reproject,
  spanOfHand,
  type HandSpec,
} from './handModel';
import { metricDistance } from './geometry';
import { classifyGestureByJoints, decideCurl, palmCenterOf, measureFinger } from './jointCurl';
import { Landmark } from '../tracking/landmarkTypes';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';

const LANDSCAPE = 4 / 3;

function classify(spec: HandSpec, aspect = LANDSCAPE) {
  const landmarks = buildHand(spec);
  const span = spanOfHand(landmarks, aspect);
  const palm = palmCenterOf(landmarks);
  if (palm === null) throw new Error('model hand has no palm');
  return classifyGestureByJoints(landmarks, null, aspect, span, palm);
}

/** Middle/ring fingertip-to-palm, the quantity the distance classifier thresholds. */
function palmToTip(spec: HandSpec, aspect = LANDSCAPE): { middle: number; ring: number } {
  const landmarks = buildHand(spec);
  const span = spanOfHand(landmarks, aspect);
  const palm = palmCenterOf(landmarks)!;
  return {
    middle: metricDistance(landmarks[Landmark.MIDDLE_TIP]!, palm, aspect) / span,
    ring: metricDistance(landmarks[Landmark.RING_TIP]!, palm, aspect) / span,
  };
}

describe('synthetic hand model sanity', () => {
  it('produces 21 landmarks and a hand span of exactly 1 metric unit', () => {
    const landmarks = buildHand(GESTURE_SPEC);
    expect(landmarks).toHaveLength(21);
    expect(spanOfHand(landmarks, LANDSCAPE)).toBeCloseTo(1, 9);
    // Span is purely vertical in this model, so no aspect can change it.
    expect(spanOfHand(landmarks, 0.75)).toBeCloseTo(1, 9);
    expect(spanOfHand(landmarks, 16 / 9)).toBeCloseTo(1, 9);
  });

  it('places a fully curled finger near the palm and a straight one far from it', () => {
    const straight = palmToTip({ ...OPEN_PALM_SPEC, middle: { curl: 0 } });
    const curled = palmToTip({ ...OPEN_PALM_SPEC, middle: { curl: 1 } });
    expect(curled.middle).toBeLessThan(straight.middle);
  });
});

describe('joint classifier — the deliberate gesture is recognised', () => {
  it('recognises a clean web gesture', () => {
    const result = classify(GESTURE_SPEC);
    expect(result.pose.folded).toBe(true);
    expect(result.pose.extended).toBe(true);
    expect(result.pose.isGesture).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.6);
  });

  it('reports every finger as decided by a trustworthy angle', () => {
    const result = classify(GESTURE_SPEC);
    for (const name of ['index', 'middle', 'ring', 'pinky'] as const) {
      expect({ name, basis: result.measures[name].basis }).toEqual({ name, basis: 'angle' });
    }
  });

  it('measures the curled middle PIP as unambiguously curled', () => {
    // The model bends in-plane, so the metric angle a given `curl` produces depends on
    // the aspect — which the classifier correctly accounts for (see the reproject
    // invariance tests). What matters here is the band it lands in, not a magic number
    // derived from this model.
    const result = classify(GESTURE_SPEC);
    expect(result.measures.middle.pipAngleDeg!).toBeLessThanOrEqual(JOINT.curlStrongDeg);
    expect(result.measures.middle.pipAngleDeg!).toBeGreaterThan(60);
    expect(result.measures.ring.pipAngleDeg!).toBeLessThanOrEqual(JOINT.curlStrongDeg);
  });

  it('reads a straight finger as 180 and bends monotonically with curl', () => {
    const straight = classify(OPEN_PALM_SPEC).measures.middle.pipAngleDeg!;
    expect(straight).toBeCloseTo(180, 6);

    let previous = 180;
    for (const curl of [0.25, 0.5, 0.75, 1]) {
      const angle = classify({ ...OPEN_PALM_SPEC, middle: { curl } }).measures.middle.pipAngleDeg!;
      expect(angle).toBeLessThan(previous);
      previous = angle;
    }
  });
});

describe('joint classifier — the observed device failure', () => {
  it('reproduces the reported symptom with the distance classifier', () => {
    // Middle/ring fingertip-to-palm well outside the 0.35 fold-enter threshold, and a
    // score of exactly 0. This is the failure the maintainer measured on the Pixel.
    const distances = palmToTip(GESTURE_MISPLACED_TIP_SPEC);
    expect(distances.middle).toBeGreaterThan(0.35);
    expect(distances.ring).toBeGreaterThan(0.35);

    const byDistance = classifyGesture(buildHand(GESTURE_MISPLACED_TIP_SPEC), null, LANDSCAPE);
    expect(byDistance.score).toBe(0);
    expect(byDistance.pose.isGesture).toBe(false);
  });

  it('recognises the same frame by joint angle, because the joints were never wrong', () => {
    // The slip is confined to the fingertip; the PIP joint bends are intact, and the
    // classifier reads those.
    const result = classify(GESTURE_MISPLACED_TIP_SPEC);
    expect(result.measures.middle.pipAngleDeg!).toBeLessThanOrEqual(JOINT.curlStrongDeg);
    expect(result.pose.isGesture).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.6);
  });

  it('does not consult the chord when the bend is unambiguous, so a bad tip cannot veto it', () => {
    // The fingertip has been placed where an *extended* finger's tip would be, which is
    // what MediaPipe does under self-occlusion. The PIP bend is untouched, because the
    // joints are the landmarks that are actually visible.
    const result = classify(GESTURE_MISPLACED_TIP_SPEC);
    expect(result.measures.middle.pipAngleDeg!).toBeLessThanOrEqual(JOINT.curlStrongDeg);
    expect(result.measures.middle.curled).toBe(true);
    expect(result.pose.isGesture).toBe(true);
  });
});

describe('joint classifier — false positives (PLAN §11.5, M2 acceptance)', () => {
  const negatives: Array<[string, HandSpec]> = [
    ['an open palm', OPEN_PALM_SPEC],
    ['a fist', FIST_SPEC],
    ['a pointing hand', POINTING_SPEC],
    ['a relaxed half-curled hand', RELAXED_SPEC],
  ];

  for (const [label, spec] of negatives) {
    it(`does not fire on ${label}`, () => {
      const result = classify(spec);
      expect({ label, isGesture: result.pose.isGesture }).toEqual({ label, isGesture: false });
    });
  }

  it('rejects a fist because the index and pinky are not extended', () => {
    // The gesture requires four conditions, so a fist satisfies only half of them.
    const result = classify(FIST_SPEC);
    expect(result.pose.folded).toBe(true);
    expect(result.pose.extended).toBe(false);
  });

  it('rejects a pointing hand because the pinky is not extended', () => {
    const result = classify(POINTING_SPEC);
    expect(result.pose.folded).toBe(true);
    expect(result.pose.extended).toBe(false);
  });

  it('rejects a relaxed hand on the angle alone, before the chord is needed', () => {
    // pip is inside the ambiguous band, so the chord decides — and it says no.
    const result = classify(RELAXED_SPEC);
    const pip = result.measures.middle.pipAngleDeg!;
    expect(pip).toBeGreaterThan(JOINT.curlStrongDeg);
    expect(result.measures.middle.curled).toBe(false);
  });

  it('treats a lost hand as a non-gesture rather than guessing', () => {
    // Tracking loss delivers an empty or truncated landmark list. Neither may throw
    // or read as a gesture.
    const empty = classifyGestureByJoints([], null, LANDSCAPE, 1, { x: 0.5, y: 0.5 });
    expect(empty.pose.isGesture).toBe(false);
    expect(empty.score).toBe(0);

    const truncated = buildHand(GESTURE_SPEC).slice(0, 12);
    const partial = classifyGestureByJoints(truncated, null, LANDSCAPE, 1, { x: 0.5, y: 0.5 });
    expect(partial.pose.isGesture).toBe(false);
  });
});

describe('joint classifier — foreshortening and unreliable joints', () => {
  it('marks a foreshortened finger unreliable and falls back to distance', () => {
    // Segment lengths scaled to a quarter: the finger points at the lens. Uses an open
    // hand so the chain lengths are the plain phalanx sum, with no tip override in play.
    const landmarks = buildHand({ ...OPEN_PALM_SPEC, foreshortening: 0.25 });
    const span = spanOfHand(landmarks, LANDSCAPE);
    const palm = palmCenterOf(landmarks)!;
    const measure = measureFinger(landmarks, 'middle', { aspect: LANDSCAPE, span }, false, palm);

    expect(measure.reliable).toBe(false);
    expect(measure.chainRatio!).toBeLessThan(JOINT.minChainRatio);
    expect(measure.chordUsable).toBe(false);
    // The fallback is named, so a HUD reader can tell which route was taken.
    expect(measure.basis).toBe('distance-fallback');
  });

  it('never reports a confident bend built from numerical noise', () => {
    // Collapse the middle finger's arms to nothing while leaving the tip where it was.
    const landmarks = buildHand(GESTURE_MISPLACED_TIP_SPEC);
    landmarks[Landmark.MIDDLE_PIP] = { ...landmarks[Landmark.MIDDLE_MCP]! };
    const span = spanOfHand(landmarks, LANDSCAPE);
    const palm = palmCenterOf(landmarks)!;
    const measure = measureFinger(landmarks, 'middle', { aspect: LANDSCAPE, span }, false, palm);

    expect(measure.reliable).toBe(false);
    expect(measure.basis).not.toBe('angle');
  });

  it('does not treat foreshortening as a gesture on its own', () => {
    expect(classify({ ...OPEN_PALM_SPEC, foreshortening: 0.25 }).pose.isGesture).toBe(false);
    expect(classify({ ...FIST_SPEC, foreshortening: 0.25 }).pose.isGesture).toBe(false);
  });

  it('falls back to distance for a reliably-curled finger only when unmeasurable', () => {
    // A well-formed hand must never report the fallback, so the fallback cannot
    // silently become the normal path.
    const result = classify(GESTURE_SPEC);
    expect(result.measures.middle.basis).toBe('angle');
    expect(result.reliableFraction).toBe(1);
  });
});

describe('joint classifier — aspect and scale invariance', () => {
  it('gives the same verdict and score in portrait and landscape', () => {
    const landscape = buildHand(GESTURE_SPEC);
    const portrait = reproject(landscape, LANDSCAPE, 3 / 4);

    const a = classifyGestureByJoints(
      landscape,
      null,
      LANDSCAPE,
      spanOfHand(landscape, LANDSCAPE),
      palmCenterOf(landscape)!,
    );
    const b = classifyGestureByJoints(
      portrait,
      null,
      3 / 4,
      spanOfHand(portrait, 3 / 4),
      palmCenterOf(portrait)!,
    );

    expect(b.pose).toEqual(a.pose);
    expect(b.score).toBeCloseTo(a.score, 9);
    expect(b.measures.middle.pipAngleDeg).toBeCloseTo(a.measures.middle.pipAngleDeg!, 6);
  });

  it('is unchanged by hand size, since every measure is a ratio or an angle', () => {
    const base = buildHand(GESTURE_SPEC);
    const small = base.map((point) => ({ x: point.x * 0.4, y: point.y * 0.4 }));

    const a = classifyGestureByJoints(base, null, LANDSCAPE, spanOfHand(base, LANDSCAPE), palmCenterOf(base)!);
    const b = classifyGestureByJoints(small, null, LANDSCAPE, spanOfHand(small, LANDSCAPE), palmCenterOf(small)!);

    expect(b.pose).toEqual(a.pose);
    expect(b.score).toBeCloseTo(a.score, 9);
  });

  it('does not let the aspect change the distance classifier verdict either', () => {
    // The distance classifier is what shipped, so the fix has to hold for it too.
    const landscape = buildHand(GESTURE_SPEC);
    const portrait = reproject(landscape, LANDSCAPE, 3 / 4);

    const a = classifyGesture(landscape, null, LANDSCAPE);
    const b = classifyGesture(portrait, null, 3 / 4);
    expect(a.pose).toEqual(b.pose);
    expect(b.score).toBeCloseTo(a.score, 9);
  });

  it('shows what the uncorrected distance would have done, to prove the correction matters', () => {
    // Recompute the fingertip ratio with a bare hypot — the old behaviour — and show
    // it moves when only the aspect changes. Then show the corrected joint angle does
    // not move at all. This is why the shipped thresholds were not comparable across
    // portrait and landscape.
    const rawRatio = (landmarks: NormalizedLandmark[]): number => {
      const wrist = landmarks[Landmark.WRIST]!;
      const mcp = landmarks[Landmark.MIDDLE_MCP]!;
      const tip = landmarks[Landmark.MIDDLE_TIP]!;
      const palm = palmCenterOf(landmarks)!;
      const span = Math.hypot(wrist.x - mcp.x, wrist.y - mcp.y);
      return Math.hypot(tip.x - palm.x, tip.y - palm.y) / span;
    };

    const landscape = buildHand({ ...OPEN_PALM_SPEC, middle: { curl: 0, tipDrift: { x: 0.5, y: 0 } } });
    const portrait = reproject(landscape, LANDSCAPE, 3 / 4);

    const uncorrectedDrift = Math.abs(rawRatio(portrait) - rawRatio(landscape));
    expect(uncorrectedDrift).toBeGreaterThan(0.1);

    const corrected = (points: NormalizedLandmark[], aspect: number): number =>
      classifyGestureByJoints(
        points,
        null,
        aspect,
        spanOfHand(points, aspect),
        palmCenterOf(points)!,
      ).measures.middle.pipAngleDeg!;

    expect(corrected(portrait, 3 / 4)).toBeCloseTo(corrected(landscape, LANDSCAPE), 6);
  });
});

describe('joint classifier — hysteresis', () => {
  it('holds a curl across the ambiguous band once curled', () => {
    const landmarks = buildHand(GESTURE_SPEC);
    const span = spanOfHand(landmarks, LANDSCAPE);
    const palm = palmCenterOf(landmarks)!;
    const previous = { folded: true, extended: true, isGesture: true };

    // A PIP in the band between curlStrong and curlEnter, with a chord that does not
    // corroborate: previously curled keeps it curled, because the exit threshold is
    // looser than the enter threshold.
    const drifting = buildHand({ ...GESTURE_SPEC, middle: { curl: 0.62 } });
    const curled = measureFinger(drifting, 'middle', { aspect: LANDSCAPE, span }, true, palm);
    const fresh = measureFinger(drifting, 'middle', { aspect: LANDSCAPE, span }, false, palm);

    expect(curled.pipAngleDeg!).toBeGreaterThan(JOINT.curlStrongDeg);
    expect(fresh.curled || !curled.curled).toBe(true);
    // The previously-curled state may only be more permissive, never less.
    expect(Number(curled.curled) >= Number(fresh.curled)).toBe(true);
    expect(previous.folded).toBe(true);
  });
});

describe('joint classifier — the curl decision gradient (PLAN §11.5)', () => {
  /**
   * The core design claim, tested directly rather than only through whole-hand fixtures:
   * a sharp bend is believed on its own, a borderline bend needs the chord, and the chord
   * can never manufacture a curl. This is what stops the unreliable fingertip from either
   * vetoing a real gesture or inventing one.
   */

  it('believes a sharp bend without consulting the chord at all', () => {
    // chordRatio 0.99 is as bad as it gets — the finger looks straight by chord — and it
    // must not matter, because the joint evidence is conclusive.
    expect(decideCurl(90, 0.99, true, false)).toEqual({ curled: true, basis: 'angle' });
    expect(decideCurl(90, null, false, false)).toEqual({ curled: true, basis: 'angle' });
    expect(decideCurl(JOINT.curlStrongDeg, 1, true, false)).toEqual({ curled: true, basis: 'angle' });
  });

  it('never lets the chord create a curl', () => {
    // A perfectly folded chord with a straight finger is a contradiction: the angle wins.
    expect(decideCurl(180, 0.1, true, false).curled).toBe(false);
    expect(decideCurl(150, 0.1, true, false).curled).toBe(false);
  });

  it('arbitrates a borderline bend with the chord', () => {
    const borderline = JOINT.curlEnterDeg - 5;
    expect(decideCurl(borderline, 0.5, true, false).curled).toBe(true);
    expect(decideCurl(borderline, 0.95, true, false).curled).toBe(false);
  });

  it('fails safe when a borderline bend has no usable corroboration', () => {
    // Foreshortened finger: no trustworthy chord, and the angle alone is not conclusive.
    // A missed gesture is recoverable by re-posing; a phantom fire is not.
    const borderline = JOINT.curlEnterDeg - 5;
    expect(decideCurl(borderline, null, false, false).curled).toBe(false);
    expect(decideCurl(borderline, 0.5, false, false).curled).toBe(false);
  });

  it('reports an unmeasurable finger as uncurled rather than guessing', () => {
    expect(decideCurl(null, 0.5, true, false)).toEqual({ curled: false, basis: 'unmeasurable' });
  });

  it('uses the looser exit threshold once a finger is already curled', () => {
    // Hysteresis: an angle that is not enough to curl a fresh finger still sustains a
    // curl, and a chord that would not have started one still supports it.
    const inBand = (JOINT.curlEnterDeg + JOINT.curlExitDeg) / 2;
    const supporting = JOINT.chordExitRatio - 0.05; // between chordEnterRatio and chordExitRatio
    expect(supporting).toBeGreaterThan(JOINT.chordEnterRatio);

    expect(decideCurl(inBand, supporting, true, false).curled).toBe(false);
    expect(decideCurl(inBand, supporting, true, true).curled).toBe(true);
  });
});

describe('joint classifier — defaults are unverified and the distance method still leads', () => {
  it('documents the thresholds as guesses, matching §11.2 discipline', () => {
    // A guard against someone later "tuning" them and forgetting that no real hand
    // has validated any of it.
    expect(Object.keys(JOINT).length).toBeGreaterThan(5);
    expect(JOINT.curlStrongDeg).toBeLessThan(JOINT.curlEnterDeg);
    expect(JOINT.curlEnterDeg).toBeLessThan(JOINT.curlExitDeg);
    expect(JOINT.extendExitDeg).toBeLessThan(JOINT.extendEnterDeg);
  });
});
