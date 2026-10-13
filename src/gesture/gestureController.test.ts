/**
 * Unit tests for the per-identity gesture pipeline (PLAN.md §11.6, §11.7, §10.3).
 *
 * These cover the behaviour that only appears once the stages are wired together:
 * that smoothing does not stop a clean gesture from firing, that releasing and
 * re-posing fires again, that a stale hand cannot count toward HOLD_MS, and that a
 * reacquired hand cannot fire on the way back in.
 */

import { describe, expect, it } from 'vitest';

import { GESTURE } from '../config';
import { Landmark } from '../tracking/landmarkTypes';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';
import type { HandIdentityId, TrackedHand } from '../tracking/handIdentity';
import { GestureController } from './gestureController';

const LANDMARK_COUNT = 21;

/** Geometry scaffold with a wrist-to-middle-MCP span of 0.2 normalized units. */
const WRIST = { x: 0.5, y: 0.8 };
const MIDDLE_MCP = { x: 0.5, y: 0.6 };
const SPAN = 0.2;
const PALM = { x: 0.516, y: 0.656 };

/** The web gesture: middle and ring folded, index and pinky extended. */
const GESTURE_POSE = { middle: 0.2 * SPAN, ring: 0.25 * SPAN, index: 1.4 * SPAN, pinky: 1.3 * SPAN };
/** An open hand: middle and ring out, index and pinky extended. */
const OPEN_POSE = { middle: 0.9 * SPAN, ring: 0.9 * SPAN, index: 1.5 * SPAN, pinky: 1.4 * SPAN };

function buildLandmarks(spec: typeof GESTURE_POSE): NormalizedLandmark[] {
  const points: NormalizedLandmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({
    x: PALM.x,
    y: PALM.y,
  }));
  points[Landmark.WRIST] = { ...WRIST };
  points[Landmark.MIDDLE_MCP] = { ...MIDDLE_MCP };
  points[Landmark.INDEX_MCP] = { x: 0.45, y: 0.62 };
  points[Landmark.RING_MCP] = { x: 0.55, y: 0.62 };
  points[Landmark.PINKY_MCP] = { x: 0.58, y: 0.64 };

  points[Landmark.MIDDLE_TIP] = { x: PALM.x, y: PALM.y - spec.middle };
  points[Landmark.RING_TIP] = { x: PALM.x + spec.ring, y: PALM.y };
  points[Landmark.INDEX_TIP] = { x: WRIST.x, y: WRIST.y - spec.index };
  points[Landmark.PINKY_TIP] = { x: WRIST.x, y: WRIST.y - spec.pinky };
  return points;
}

/** A tracked hand as `HandIdentityTracker.snapshot()` would present it. */
function trackedHand(
  identity: HandIdentityId,
  landmarks: NormalizedLandmark[],
  overrides: Partial<TrackedHand> = {},
): TrackedHand {
  return {
    identity,
    landmarks,
    handedness: { label: identity === 'left' ? 'Left' : 'Right', score: 0.95 },
    palmCenter: { x: PALM.x, y: PALM.y },
    identityMatchScore: 1,
    stalenessMs: 0,
    isStale: false,
    handednessConflicted: false,
    reacquiredAtMs: null,
    ...overrides,
  };
}

/** Step the controller and count fires. */
function fires(
  controller: GestureController,
  steps: readonly { landmarks: NormalizedLandmark[]; atMs: number; stale?: boolean }[],
): number {
  let count = 0;
  for (const step of steps) {
    const frame = controller.observe(
      [
        trackedHand('right', step.landmarks, {
          isStale: step.stale ?? false,
          stalenessMs: step.stale ? 40 : 0,
        }),
      ],
      step.atMs,
    );
    count += frame.events.length;
  }
  return count;
}

describe('GestureController — end to end through smoothing', () => {
  it('fires once for a cleanly held gesture', () => {
    const controller = new GestureController();
    const steps = Array.from({ length: 40 }, (_, i) => ({
      landmarks: buildLandmarks(GESTURE_POSE),
      atMs: i * 16,
    }));

    expect(fires(controller, steps)).toBe(1);
  });

  it('does not fire for an open hand', () => {
    const controller = new GestureController();
    const steps = Array.from({ length: 40 }, (_, i) => ({
      landmarks: buildLandmarks(OPEN_POSE),
      atMs: i * 16,
    }));

    expect(fires(controller, steps)).toBe(0);
  });

  it('fires once even if the pose is held for a long time', () => {
    const controller = new GestureController();
    const steps = Array.from({ length: 400 }, (_, i) => ({
      landmarks: buildLandmarks(GESTURE_POSE),
      atMs: i * 16,
    }));

    expect(fires(controller, steps)).toBe(1);
  });

  it('fires again after a release and a fresh pose', () => {
    const controller = new GestureController();
    const steps: { landmarks: NormalizedLandmark[]; atMs: number }[] = [];
    let t = 0;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let i = 0; i < 40; i += 1) steps.push({ landmarks: buildLandmarks(GESTURE_POSE), atMs: (t += 16) });
      for (let i = 0; i < 60; i += 1) steps.push({ landmarks: buildLandmarks(OPEN_POSE), atMs: (t += 16) });
    }

    expect(fires(controller, steps)).toBe(3);
  });

  it('reports the state and score the HUD needs', () => {
    const controller = new GestureController();
    const frame = controller.observe([trackedHand('right', buildLandmarks(GESTURE_POSE))], 0);
    const hand = frame.hands[0]!;

    expect(hand.identity).toBe('right');
    expect(hand.pose.isGesture).toBe(true);
    expect(hand.score).toBeGreaterThanOrEqual(GESTURE.minGestureScore);
    expect(hand.rawScore).toBeGreaterThan(0);
    expect(hand.geometry?.span).toBeCloseTo(SPAN, 6);
    expect(hand.frozen).toBe(false);
  });

  it('exposes render-smoothed landmarks separately from the classify stream', () => {
    const controller = new GestureController();
    controller.observe([trackedHand('right', buildLandmarks(GESTURE_POSE))], 0);
    const render = controller.smoothedForRender('right');

    expect(render).not.toBeNull();
    expect(render).toHaveLength(LANDMARK_COUNT);
  });
});

describe('GestureController — loss and reacquisition (§10.3, §11.8)', () => {
  it('freezes rather than advancing while the hand is stale', () => {
    const controller = new GestureController();
    // Long enough on its own that a non-frozen machine would have fired.
    const steps = Array.from({ length: 40 }, (_, i) => ({
      landmarks: buildLandmarks(GESTURE_POSE),
      atMs: i * 16,
      stale: true,
    }));

    // Frozen frames cannot satisfy HOLD_MS from unobserved data.
    expect(fires(controller, steps)).toBe(0);
  });

  it('resets on loss, so a held pose cannot survive an absence', () => {
    const controller = new GestureController();
    controller.observe([trackedHand('right', buildLandmarks(OPEN_POSE))], 0);
    // Pose held briefly, then the identity disappears entirely for a while.
    controller.observe([trackedHand('right', buildLandmarks(GESTURE_POSE))], 16);
    controller.observe([], 32); // grace expired: identity gone
    controller.observe([], 2000);

    // Reappearing already in pose must not fire immediately.
    const frame = controller.observe([trackedHand('right', buildLandmarks(GESTURE_POSE))], 2016);
    expect(frame.events).toHaveLength(0);
  });

  it('blocks arming on reacquisition until the hand is seen released', () => {
    const controller = new GestureController();
    const reacquired = trackedHand('right', buildLandmarks(GESTURE_POSE), { reacquiredAtMs: 100 });

    // Held for well past HOLD_MS, but the rearm block is in force.
    const held = Array.from({ length: 60 }, (_, i) => ({
      hand: reacquired,
      atMs: 100 + i * 16,
    }));
    let fired = 0;
    for (const step of held) {
      fired += controller.observe([step.hand], step.atMs).events.length;
    }
    expect(fired).toBe(0);

    // Now observed released for REARM_MS, then posed again.
    const tail: { landmarks: NormalizedLandmark[]; atMs: number }[] = [];
    let t = held[held.length - 1]!.atMs;
    for (let i = 0; i < 30; i += 1) {
      tail.push({ landmarks: buildLandmarks(OPEN_POSE), atMs: (t += 16) });
    }
    for (let i = 0; i < 40; i += 1) {
      tail.push({ landmarks: buildLandmarks(GESTURE_POSE), atMs: (t += 16) });
    }
    expect(fires(controller, tail)).toBe(1);
  });

  it('tracks left and right independently', () => {
    const controller = new GestureController();
    let t = 0;
    let fired = 0;
    for (let i = 0; i < 40; i += 1) {
      const frame = controller.observe(
        [
          trackedHand('left', buildLandmarks(GESTURE_POSE)),
          trackedHand('right', buildLandmarks(OPEN_POSE)),
        ],
        (t += 16),
      );
      fired += frame.events.length;
    }

    expect(fired).toBe(1);
    expect(frame0EventsIdentity(controller)).toBe('left');
  });
});

/** The identity of the single fire observed above, replayed deterministically. */
function frame0EventsIdentity(controller: GestureController): HandIdentityId {
  controller.reset();
  for (let i = 0; i < 40; i += 1) {
    const frame = controller.observe(
      [
        trackedHand('left', buildLandmarks(GESTURE_POSE)),
        trackedHand('right', buildLandmarks(OPEN_POSE)),
      ],
      i * 16,
    );
    if (frame.events.length > 0) return frame.events[0]!.identity;
  }
  throw new Error('expected a fire from the left hand');
}
