/**
 * Safety regression against the real device captures (PLAN.md §11, §12).
 *
 * The captures in `fixtures/device-gesture-captures.json` are player-labelled: 31 negative
 * observations (open hands) and 39 positive ones (the iconic gesture, wrist away — including a
 * take the player confirmed explicitly).
 *
 * **The shipped classifiers currently reject all 70**, which is correct for the negatives and is
 * the open defect for the positives. `docs/M2_GESTURE_ANALYSIS.md` records the measurement, and
 * the conclusion is that no threshold change is justified: the labelled classes overlap in every
 * feature measured, and one labelled negative contains an observation that measures as a fully
 * curled gesture while every labelled positive measures as straight.
 *
 * This file therefore pins the **one property that must never regress** — a recorded open hand
 * must never produce a gesture verdict — rather than asserting a positive rate. Asserting 0/39 as
 * expected behaviour would turn a known defect into a specification, and asserting a positive rate
 * the data does not support would be a fabricated success.
 *
 * When the follow-up recordings arrive (`docs/M2_GESTURE_ANALYSIS.md` lists what is needed), the
 * positive side of this matrix is what should improve; the negative side is what must not.
 */

import { describe, expect, it } from 'vitest';

import fixture from '../../fixtures/device-gesture-captures.json';
import { classifyGesture } from '../gesture/classifyGesture';
import { classifyGestureByJoints, palmCenterOf, spanOf } from '../gesture/jointCurl';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';

/** The camera requested 640x480; the captures do not record the negotiated size, so assume the
 * request. Recorded in the capture from this change onward. */
const ASPECT = 4 / 3;

interface FixtureFrame {
  tMs: number;
  identity: string;
  label: string;
  score: number;
  lm: number[][];
}

interface Verdict {
  capture: string;
  take: number;
  truth: string;
  distance: boolean;
  angle: boolean;
}

function verdictsFor(): Verdict[] {
  const out: Verdict[] = [];
  for (const capture of fixture.captures) {
    for (const take of capture.takes) {
      for (const frame of take.frames as FixtureFrame[]) {
        const landmarks = frame.lm.map(([x, y, z]) => ({
          x: x!,
          y: y!,
          z: z!,
        })) as NormalizedLandmark[];
        const distance = classifyGesture(landmarks, null, ASPECT);
        const angle = classifyGestureByJoints(
          landmarks,
          null,
          ASPECT,
          spanOf(landmarks, ASPECT),
          palmCenterOf(landmarks)!,
        );
        out.push({
          capture: capture.capture,
          take: take.id,
          truth: take.truth,
          distance: distance.pose.isGesture,
          angle: angle.pose.isGesture,
        });
      }
    }
  }
  return out;
}

const verdicts = verdictsFor();
const negatives = verdicts.filter((v) => v.truth === 'negative');
const positives = verdicts.filter((v) => v.truth === 'positive');

describe('the fixture carries the labelled device captures', () => {
  it('has the negative and positive observations the analysis describes', () => {
    expect(verdicts).toHaveLength(70);
    expect(negatives).toHaveLength(31);
    expect(positives).toHaveLength(39);
  });
});

describe('no recorded open hand fires the gesture (§12: false positives unacceptable)', () => {
  it('rejects every negative with the shipped distance classifier', () => {
    const firing = negatives.filter((v) => v.distance);
    expect(firing.map((v) => `${v.capture} take${v.take}`)).toEqual([]);
  });

  it('rejects every negative with the joint-angle classifier', () => {
    const firing = negatives.filter((v) => v.angle);
    expect(firing.map((v) => `${v.capture} take${v.take}`)).toEqual([]);
  });

  it('rejects every negative under both classifiers at once', () => {
    // Belt and braces: a change that made the two classifiers fire on different negatives would
    // still be a regression, and neither single-classifier assertion would catch it.
    expect(negatives.filter((v) => v.distance || v.angle)).toEqual([]);
  });

  it('documents that one negative observation measures as fully curled', () => {
    // This is the observation that makes a threshold change unsafe. Capture 3 take 5 frame 3 reads
    // middle PIP 20 degrees, ring PIP 3 degrees — both curled — while the player labelled the take
    // "open". Only the index-extension requirement keeps it from firing, which is why that
    // requirement is load-bearing and must not be weakened.
    const take5 = fixture.captures[2]!.takes.find((take) => take.id === 5)!;
    const third = take5.frames[2] as FixtureFrame;
    const landmarks = third.lm.map(([x, y, z]) => ({ x: x!, y: y!, z: z! })) as NormalizedLandmark[];
    const angle = classifyGestureByJoints(
      landmarks,
      null,
      ASPECT,
      spanOf(landmarks, ASPECT),
      palmCenterOf(landmarks)!,
    );

    expect(angle.measures.middle.curled).toBe(true);
    expect(angle.measures.ring.curled).toBe(true);
    // Not a gesture, because the index is not extended.
    expect(angle.measures.index.curled).toBe(true);
    expect(angle.pose.isGesture).toBe(false);
  });
});

describe('the current state of the positive side, recorded as a known defect', () => {
  it('rejects every recorded positive — the open defect this analysis documents', () => {
    // Stated as a measurement, not as desired behaviour. If this ever starts passing, the number
    // below changes and the analysis needs revisiting; that is the point of pinning it.
    const recognised = positives.filter((v) => v.distance || v.angle);
    expect(recognised).toHaveLength(0);
  });

  it('is not a scoring artefact: the per-finger geometry itself reads as straight', () => {
    // Rules out "the thresholds are fine, the score gate is too strict" — which would be a cheap
    // fix. For a confirmed positive, the measured PIP angles are simply above the curl band.
    const cap1 = fixture.captures[0]!.takes[0]!.frames[0] as FixtureFrame;
    const landmarks = cap1.lm.map(([x, y, z]) => ({ x: x!, y: y!, z: z! })) as NormalizedLandmark[];
    const angle = classifyGestureByJoints(
      landmarks,
      null,
      ASPECT,
      spanOf(landmarks, ASPECT),
      palmCenterOf(landmarks)!,
    );

    // The measurement is confident (well-conditioned) and says "not curled".
    expect(angle.measures.middle.reliable).toBe(true);
    expect(angle.measures.middle.pipAngleDeg!).toBeGreaterThan(100);
    expect(angle.pose.folded).toBe(false);
  });
});
