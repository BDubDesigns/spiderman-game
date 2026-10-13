/**
 * Integration test: the MediaPipe mapping stage feeding the identity stage.
 *
 * `handIdentity.test.ts` tests association policy against synthetic
 * `RawHandFrame`s, and `handTracker.test.ts` tests result mapping in isolation.
 * Neither covers the seam between them — and the seam is where the two-handed
 * bug lived: the model reporting two hands and the tracker *rendering* two hands
 * are different stages, and only this path proves the second follows from the
 * first.
 *
 * So this file deliberately goes through the real `mapDetectedHands()` — the same
 * function `CameraHandSource` uses — rather than hand-building `RawHandFrame`s.
 * If `mapDetectedHands` ever changes how it derives handedness, these tests fail
 * rather than silently drifting apart.
 *
 * No WASM, no model, no camera: the input is a `DetectedHandLike`, which is the
 * structural shape of `HandLandmarkerResult`.
 */

import { describe, expect, it } from 'vitest';

import { IDENTITY } from '../config';
import { LANDMARK_COUNT, Landmark, type NormalizedLandmark } from './landmarkTypes';
import { HandIdentityTracker, type HandIdentityId } from './handIdentity';
import { mapDetectedHands, type DetectedHandLike } from './handTracker';

const SOURCE_WIDTH = 640;
const SOURCE_HEIGHT = 480;

const PALM_INDEX = [
  Landmark.WRIST,
  Landmark.INDEX_MCP,
  Landmark.MIDDLE_MCP,
  Landmark.RING_MCP,
  Landmark.PINKY_MCP,
] as const;

/**
 * One hand in the shape MediaPipe returns: landmarks, plus handedness wrapped in
 * an outer array (the model emits one classification list per hand) and carrying
 * the extra `visibility`/`presence` fields we deliberately drop.
 */
function modelHand(label: string, x: number, y: number, score = 0.93) {
  return {
    landmarks: [
      Array.from({ length: LANDMARK_COUNT }, (_, index): NormalizedLandmark & { visibility: number; presence: number } => {
        const onPalm = (PALM_INDEX as readonly number[]).includes(index);
        return {
          x: onPalm ? x : x + 0.01,
          y: onPalm ? y : y - 0.06 - (index % 4) * 0.01,
          visibility: 0.99,
          presence: 0.98,
        };
      }),
    ],
    handedness: [[{ categoryName: label, score }]],
  };
}

/** A `HandLandmarkerResult`-shaped frame from the given hands. */
function modelFrame(...hands: ReturnType<typeof modelHand>[]): DetectedHandLike {
  return {
    landmarks: hands.map((h) => h.landmarks[0]!),
    // Unwrap exactly one level, matching `HandLandmarkerResult.handedness:
    // Category[][]` and the existing `detectedHand` helper in handTracker.test.ts.
    handedness: hands.map((h) => h.handedness[0]!),
  };
}

function tracker(): HandIdentityTracker {
  return new HandIdentityTracker({ sourceWidth: SOURCE_WIDTH, sourceHeight: SOURCE_HEIGHT });
}

/** Feed a model-shaped frame through the real mapping stage, then association. */
function step(
  t: HandIdentityTracker,
  nowMs: number,
  ...hands: ReturnType<typeof modelHand>[]
) {
  // `swapHandedness: false` — the M1 default, pending the physical check (§8).
  const mapped = mapDetectedHands(modelFrame(...hands), false);
  return t.update(mapped, nowMs);
}

function handFor(
  hands: readonly { identity: HandIdentityId; palmCenter: { x: number; y: number } }[],
  identity: HandIdentityId,
) {
  return hands.find((h) => h.identity === identity);
}

describe('MediaPipe result -> identity -> rendered hands', () => {
  it('maps a model "Left" category to the left identity', () => {
    const frame = step(tracker(), 0, modelHand('Left', 0.30, 0.5));
    expect(handFor(frame.hands, 'left')?.palmCenter.x).toBeCloseTo(0.30, 6);
    expect(handFor(frame.hands, 'right')).toBeUndefined();
  });

  it('tracks both hands when the model reports both in the first frame', () => {
    const frame = step(
      tracker(),
      0,
      modelHand('Left', 0.30, 0.5),
      modelHand('Right', 0.70, 0.5),
    );

    expect(frame.hands).toHaveLength(2);
    expect(handFor(frame.hands, 'left')?.palmCenter.x).toBeCloseTo(0.30, 6);
    expect(handFor(frame.hands, 'right')?.palmCenter.x).toBeCloseTo(0.70, 6);
  });

  it('tracks both hands when the second hand appears after the first (left then right)', () => {
    const t = tracker();
    step(t, 0, modelHand('Left', 0.30, 0.5));

    // The model now reports two hands: the left is still there, the right is new.
    const frame = step(t, 33, modelHand('Left', 0.30, 0.5), modelHand('Right', 0.70, 0.5));

    expect(frame.hands).toHaveLength(2);
    expect(handFor(frame.hands, 'left')?.palmCenter.x).toBeCloseTo(0.30, 6);
    expect(handFor(frame.hands, 'right')?.palmCenter.x).toBeCloseTo(0.70, 6);
    expect(frame.stats.adopted).toBe(1);
  });

  it('tracks both hands when the second hand appears after the first (right then left)', () => {
    const t = tracker();
    step(t, 0, modelHand('Right', 0.70, 0.5));

    // Reversed detection order too, as MediaPipe may return either.
    const frame = step(t, 33, modelHand('Right', 0.70, 0.5), modelHand('Left', 0.30, 0.5));

    expect(frame.hands).toHaveLength(2);
    expect(handFor(frame.hands, 'left')?.palmCenter.x).toBeCloseTo(0.30, 6);
    expect(handFor(frame.hands, 'right')?.palmCenter.x).toBeCloseTo(0.70, 6);
  });

  it('keeps both hands across a session once adopted', () => {
    const t = tracker();
    step(t, 0, modelHand('Left', 0.30, 0.5));
    step(t, 33, modelHand('Left', 0.30, 0.5), modelHand('Right', 0.70, 0.5));

    const frame = step(t, 66, modelHand('Left', 0.32, 0.5), modelHand('Right', 0.72, 0.5));

    expect(frame.hands).toHaveLength(2);
    expect(frame.stats.matched).toBe(2);
    expect(frame.stats.adopted).toBe(0);
    expect(handFor(frame.hands, 'left')?.palmCenter.x).toBeCloseTo(0.32, 6);
    expect(handFor(frame.hands, 'right')?.palmCenter.x).toBeCloseTo(0.72, 6);
  });

  it('renders one hand, not two, when the model double-reports a single hand', () => {
    const t = tracker();
    step(t, 0, modelHand('Right', 0.50, 0.5));

    // Same hand twice, a few pixels apart, both labelled Right.
    const frame = step(t, 33, modelHand('Right', 0.500, 0.5), modelHand('Right', 0.504, 0.5));

    expect(frame.hands).toHaveLength(1);
    expect(handFor(frame.hands, 'right')).toBeDefined();
    expect(frame.stats.adopted).toBe(0);
  });

  it('does not lose the first hand when a second one enters and leaves', () => {
    const t = tracker();
    step(t, 0, modelHand('Left', 0.30, 0.5));
    step(t, 33, modelHand('Left', 0.30, 0.5), modelHand('Right', 0.70, 0.5));

    // The right hand leaves; the left stays observed well past the grace period.
    const frame = step(t, IDENTITY.graceMs + 200, modelHand('Left', 0.30, 0.5));

    expect(handFor(frame.hands, 'left')?.palmCenter.x).toBeCloseTo(0.30, 6);
    expect(handFor(frame.hands, 'right')).toBeUndefined();
    expect(frame.stats.losses).toBe(1);
  });
});
