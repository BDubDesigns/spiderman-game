/**
 * Tests for classifier selection and the dual-reporting diagnostic (PLAN.md §11.5).
 *
 * The safety property under test is that running the joint-angle classifier for
 * *comparison* must not change gameplay: only the selected method may reach the state
 * machine. The interesting fixture is a hand whose fingertip the model has misplaced —
 * which the distance classifier rejects and the joint classifier accepts. That makes the
 * two methods genuinely disagree, so "which one is driving?" is answerable.
 *
 * Every safeguard §11.7/§11.8 requires is re-asserted under **both** methods, because
 * switching classifier must not weaken them.
 */

import { describe, expect, it } from 'vitest';

import { GESTURE_METHOD } from '../config';
import { GestureController } from './gestureController';
import {
  FIST_SPEC,
  GESTURE_MISPLACED_TIP_SPEC,
  GESTURE_SPEC,
  OPEN_PALM_SPEC,
  buildHand,
} from './handModel';
import { palmCenterOf } from './jointCurl';
import type { TrackedHand } from '../tracking/handIdentity';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';

function handOf(landmarks: NormalizedLandmark[], isStale = false): TrackedHand {
  return {
    identity: 'right',
    landmarks,
    handedness: { label: 'Right', score: 0.95 },
    palmCenter: palmCenterOf(landmarks) ?? { x: 0.5, y: 0.5 },
    identityMatchScore: 1,
    stalenessMs: isStale ? 20 : 0,
    isStale,
    handednessConflicted: false,
    reacquiredAtMs: null,
  };
}

/** Drive one hand at 60 fps and report what happened. */
function drive(
  controller: GestureController,
  frames: Array<{ landmarks: NormalizedLandmark[]; stale?: boolean }>,
) {
  let fires = 0;
  let last: ReturnType<GestureController['update']> | null = null;
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]!;
    last = controller.update([handOf(frame.landmarks, frame.stale ?? false)], i * 16);
    fires += last.events.length;
  }
  return { fires, hands: last?.hands ?? [] };
}

function framesOf(landmarks: NormalizedLandmark[], count: number, stepMs = 16) {
  void stepMs;
  return Array.from({ length: count }, () => ({ landmarks }));
}

describe('classifier selection', () => {
  it('defaults to the distance classifier, as PLAN §11.5 requires', () => {
    expect(new GestureController().activeMethod).toBe(GESTURE_METHOD);
    expect(GESTURE_METHOD).toBe('distance');
  });

  it('can be switched to the joint-angle classifier', () => {
    const controller = new GestureController('angle');
    expect(controller.activeMethod).toBe('angle');
    controller.setMethod('distance');
    expect(controller.activeMethod).toBe('distance');
  });
});

describe('the two classifiers disagree on the observed failure case', () => {
  const misplaced = buildHand(GESTURE_MISPLACED_TIP_SPEC);

  it('reports both verdicts for the same frame', () => {
    const controller = new GestureController('distance');
    const { hands } = drive(controller, framesOf(misplaced, 1));
    const hand = hands[0]!;

    expect(hand.method).toBe('distance');
    // The active method rejects it — this is the device bug.
    expect(hand.pose.isGesture).toBe(false);
    // The alternative recognises it, on identical landmarks.
    expect(hand.alternate.method).toBe('angle');
    expect(hand.alternate.pose.isGesture).toBe(true);
    expect(hand.alternate.score).toBeGreaterThan(hand.rawScore);
  });

  it('does NOT let the non-selected classifier change gameplay', () => {
    // The safety property: a diagnostic that could fire webs would be a bug. The joint
    // classifier accepts this hand, so if it leaked into the machine there would be a
    // fire here.
    const controller = new GestureController('distance');
    const { fires } = drive(controller, framesOf(misplaced, 60));

    expect(fires).toBe(0);
  });

  it('DOES fire on the same hand once the joint classifier is selected', () => {
    const controller = new GestureController('angle');
    const { fires } = drive(controller, framesOf(misplaced, 60));

    expect(fires).toBe(1);
  });

  it('reports the alternate the other way round when the angle method is active', () => {
    const controller = new GestureController('angle');
    const { hands } = drive(controller, framesOf(misplaced, 1));

    expect(hands[0]!.method).toBe('angle');
    expect(hands[0]!.pose.isGesture).toBe(true);
    expect(hands[0]!.alternate.method).toBe('distance');
    expect(hands[0]!.alternate.pose.isGesture).toBe(false);
  });
});

describe('safeguards hold under both classifiers', () => {
  for (const method of ['distance', 'angle'] as const) {
    describe(`with the ${method} classifier`, () => {
      it('fires exactly once for a held gesture', () => {
        const controller = new GestureController(method);
        const { fires } = drive(controller, framesOf(buildHand(GESTURE_SPEC), 200));
        expect(fires).toBe(1);
      });

      it('does not fire on an open palm', () => {
        const controller = new GestureController(method);
        expect(drive(controller, framesOf(buildHand(OPEN_PALM_SPEC), 120)).fires).toBe(0);
      });

      it('does not fire on a fist', () => {
        const controller = new GestureController(method);
        expect(drive(controller, framesOf(buildHand(FIST_SPEC), 120)).fires).toBe(0);
      });

      it('freezes rather than advancing a stale hand', () => {
        const controller = new GestureController(method);
        const frames = framesOf(buildHand(GESTURE_SPEC), 120).map((frame) => ({
          ...frame,
          stale: true,
        }));
        expect(drive(controller, frames).fires).toBe(0);
      });

      it('blocks arming on reacquisition even while already in pose', () => {
        const controller = new GestureController(method);
        const gesturing = buildHand(GESTURE_SPEC);
        const tracked = handOf(gesturing);
        tracked.reacquiredAtMs = 0;

        let fires = 0;
        for (let i = 0; i < 120; i += 1) {
          fires += controller.update([tracked], i * 16).events.length;
        }
        expect(fires).toBe(0);
      });

      it('re-fires after a release and a fresh pose', () => {
        const controller = new GestureController(method);
        const gesture = buildHand(GESTURE_SPEC);
        const open = buildHand(OPEN_PALM_SPEC);
        const frames = [
          ...framesOf(gesture, 30),
          ...framesOf(open, 60),
          ...framesOf(gesture, 30),
          ...framesOf(open, 60),
          ...framesOf(gesture, 30),
        ];
        expect(drive(controller, frames).fires).toBe(3);
      });
    });
  }
});

describe('aspect plumbing', () => {
  it('ignores a non-positive or non-finite aspect rather than producing NaN', () => {
    const controller = new GestureController('distance');
    controller.setAspect(0);
    controller.setAspect(-1);
    controller.setAspect(Number.NaN);
    const { hands } = drive(controller, framesOf(buildHand(GESTURE_SPEC), 1));
    expect(hands).toHaveLength(1);
    expect(Number.isFinite(hands[0]!.rawScore)).toBe(true);
  });

  it('accepts a portrait aspect and still reaches a verdict', () => {
    const controller = new GestureController('angle');
    controller.setAspect(3 / 4);
    const { hands } = drive(controller, framesOf(buildHand(GESTURE_SPEC), 1));
    expect(hands[0]!.method).toBe('angle');
    expect(Number.isFinite(hands[0]!.rawScore)).toBe(true);
  });
});
