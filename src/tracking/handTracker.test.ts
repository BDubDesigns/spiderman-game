/**
 * Unit tests for the MediaPipe adapter (PLAN.md §5, §7.3, §8).
 *
 * The model is replaced by an injected factory, so what is tested here is the
 * project's *policy* — result mapping, the handedness-label correction, the
 * delegate fallback, failure accounting and the stale-frame contract — without
 * needing WASM, a model file or a camera.
 */

import { describe, expect, it } from 'vitest';

import type { HandLandmarkerResult } from '@mediapipe/tasks-vision';

import { INFERENCE } from '../config';
import { LANDMARK_COUNT, type HandednessLabel } from './landmarkTypes';
import {
  CameraHandSource,
  HandTracker,
  mapDetectedHands,
  toHandednessLabel,
  type DetectedHandLike,
  type HandLandmarkerLike,
  type HandTrackerOptions,
  type LandmarkerFactory,
} from './handTracker';

/**
 * A stand-in for the video element. `detectForVideo` here ignores its argument,
 * so nothing ever dereferences this.
 */
const fakeVideo = {} as HTMLVideoElement;

function detectedHand(label: string, score = 0.9): DetectedHandLike {
  return {
    landmarks: [
      Array.from({ length: LANDMARK_COUNT }, (_, i) => ({
        x: 0.5 + i * 0.001,
        y: 0.5,
        // Extra fields the real model returns and we deliberately drop.
        visibility: 0.99,
        presence: 0.98,
      })),
    ],
    handedness: [[{ categoryName: label, score }]],
  };
}

function makeOptions(overrides: Partial<HandTrackerOptions> = {}): HandTrackerOptions {
  return {
    wasmBasePath: '/wasm',
    modelAssetPath: '/models/hand_landmarker.task',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    preferredDelegate: 'GPU',
    ...overrides,
  };
}

/** A factory that fails for the delegates in `failOn` and records every attempt. */
function fakeFactory(
  failOn: ReadonlySet<'GPU' | 'CPU'> = new Set(),
  result: DetectedHandLike = detectedHand('Left'),
): { factory: LandmarkerFactory; attempts: Array<'GPU' | 'CPU'>; closed: () => boolean } {
  const attempts: Array<'GPU' | 'CPU'> = [];
  let closed = false;

  // Not `async`: these factories never await, and returning the promise keeps the
  // rejection path explicit rather than incidental.
  const factory: LandmarkerFactory = (delegate) => {
    attempts.push(delegate);
    if (failOn.has(delegate)) {
      return Promise.reject(new Error(`${delegate} delegate unavailable`));
    }
    const landmarker: HandLandmarkerLike = {
      detectForVideo: () => result,
      close: () => {
        closed = true;
      },
    };
    return Promise.resolve(landmarker);
  };

  return { factory, attempts, closed: () => closed };
}

describe('mediapipe type contract', () => {
  it('accepts a genuine HandLandmarkerResult, so library churn fails the build', () => {
    // This object must satisfy MediaPipe's own published type. If the library
    // renames a field, this stops compiling — which is the point: the alternative
    // is a runtime that silently reports zero hands.
    const landmark = { x: 0.25, y: 0.5, z: -0.01, visibility: 0.97 };
    const real: HandLandmarkerResult = {
      landmarks: [[landmark]],
      worldLandmarks: [[{ x: 0, y: 0, z: 0, visibility: 1 }]],
      handednesses: [
        [{ score: 0.88, index: 0, categoryName: 'Left', displayName: 'Left' }],
      ],
      handedness: [
        [{ score: 0.88, index: 0, categoryName: 'Left', displayName: 'Left' }],
      ],
    };

    const hands = mapDetectedHands(real, false);

    expect(hands).toHaveLength(1);
    expect(hands[0]!.landmarks).toHaveLength(1);
    expect(hands[0]!.landmarks[0]!.x).toBeCloseTo(0.25, 12);
    // `visibility` is dropped, not carried into our landmark type.
    expect(Object.keys(hands[0]!.landmarks[0]!).sort()).toEqual(['x', 'y', 'z']);
    expect(hands[0]!.handedness).toEqual({ label: 'Left', score: 0.88 });
  });
});

describe('toHandednessLabel', () => {
  it('passes the model label through untouched by default', () => {
    expect(toHandednessLabel('Left', false)).toBe('Left');
    expect(toHandednessLabel('Right', false)).toBe('Right');
  });

  it('applies exactly one global swap when the empirical check says inverted', () => {
    expect(toHandednessLabel('Left', true)).toBe('Right');
    expect(toHandednessLabel('Right', true)).toBe('Left');
  });

  it('treats an unrecognised category as Right rather than throwing', () => {
    expect(toHandednessLabel('', false)).toBe('Right');
    expect(toHandednessLabel('Sideways', false)).toBe('Right');
  });
});

describe('mapDetectedHands', () => {
  it('maps landmarks and handedness, dropping fields we do not consume', () => {
    const hands = mapDetectedHands(detectedHand('Left', 0.81), false);

    expect(hands).toHaveLength(1);
    expect(hands[0]!.landmarks).toHaveLength(LANDMARK_COUNT);
    expect(hands[0]!.handedness).toEqual({ label: 'Left', score: 0.81 });
    // `visibility`/`presence` are not model confidences we report, and must not
    // leak into our landmark type.
    expect(Object.keys(hands[0]!.landmarks[0]!).sort()).toEqual(['x', 'y']);
  });

  it('carries z through without using it for position (§8 Rule C)', () => {
    const result: DetectedHandLike = {
      landmarks: [Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.1, y: 0.2, z: -0.03 }))],
      handedness: [[{ categoryName: 'Right', score: 0.5 }]],
    };
    expect(mapDetectedHands(result, false)[0]!.landmarks[0]!.z).toBeCloseTo(-0.03, 12);
  });

  it('maps two hands independently and swaps both labels when asked to', () => {
    const result: DetectedHandLike = {
      landmarks: [detectedHand('Left').landmarks[0]!, detectedHand('Right').landmarks[0]!],
      handedness: [
        [{ categoryName: 'Left', score: 0.9 }],
        [{ categoryName: 'Right', score: 0.8 }],
      ],
    };
    const hands = mapDetectedHands(result, true);
    expect(hands.map((h) => h.handedness.label)).toEqual(['Right', 'Left']);
  });

  it('survives a hand with no handedness classification rather than crashing', () => {
    const result: DetectedHandLike = {
      landmarks: [detectedHand('Left').landmarks[0]!],
      handedness: [],
    };
    const hands = mapDetectedHands(result, false);
    expect(hands).toHaveLength(1);
    expect(hands[0]!.handedness.score).toBe(0);
  });
});

describe('HandTracker initialization (§7.3)', () => {
  it('initializes on the preferred delegate and reports no fallback', async () => {
    const { factory, attempts } = fakeFactory();
    const tracker = new HandTracker(makeOptions({ factory }));

    const stats = await tracker.init();

    expect(attempts).toEqual(['GPU']);
    expect(stats.delegate).toBe('GPU');
    expect(stats.delegateFallback).toBe(false);
    expect(stats.delegateMessage).toBeNull();
    expect(tracker.ready).toBe(true);
  });

  it('falls back to CPU when the GPU delegate fails, and says why', async () => {
    const { factory, attempts } = fakeFactory(new Set(['GPU']));
    const tracker = new HandTracker(makeOptions({ factory }));

    const stats = await tracker.init();

    expect(attempts).toEqual(['GPU', 'CPU']);
    expect(stats.delegate).toBe('CPU');
    expect(stats.delegateFallback).toBe(true);
    expect(stats.delegateMessage).toContain('GPU delegate unavailable');
  });

  it('does not try GPU at all when CPU is preferred', async () => {
    const { factory, attempts } = fakeFactory();
    const tracker = new HandTracker(makeOptions({ factory, preferredDelegate: 'CPU' }));
    await tracker.init();
    expect(attempts).toEqual(['CPU']);
  });

  it('rejects when every delegate fails, so the caller can offer the simulator', async () => {
    const { factory } = fakeFactory(new Set(['GPU', 'CPU']));
    const tracker = new HandTracker(makeOptions({ factory }));

    await expect(tracker.init()).rejects.toThrow(/no usable delegate|failed to initialize/i);
    expect(tracker.ready).toBe(false);
  });
});

describe('HandTracker detection', () => {
  it('refuses to detect before initialization instead of returning empty hands', () => {
    const { factory } = fakeFactory();
    const tracker = new HandTracker(makeOptions({ factory }));
    expect(() => tracker.detect(fakeVideo, 0)).toThrow(/before a successful init/i);
  });

  it('records call counts, hand counts and a measured duration', async () => {
    const { factory } = fakeFactory(new Set(), detectedHand('Left'));
    const tracker = new HandTracker(makeOptions({ factory }));
    await tracker.init();

    const hands = tracker.detect(fakeVideo, 16);

    expect(hands).toHaveLength(1);
    expect(tracker.stats.detectCalls).toBe(1);
    expect(tracker.stats.lastHandCount).toBe(1);
    expect(tracker.stats.lastDetectMs).toBeGreaterThanOrEqual(0);
    expect(tracker.stats.incompleteHands).toBe(0);
  });

  it('counts incomplete hands without discarding them', async () => {
    const truncated: DetectedHandLike = {
      landmarks: [detectedHand('Left').landmarks[0]!.slice(0, 5)],
      handedness: [[{ categoryName: 'Left', score: 0.9 }]],
    };
    const tracker = new HandTracker(makeOptions({ factory: fakeFactory(new Set(), truncated).factory }));
    await tracker.init();

    expect(tracker.detect(fakeVideo, 0)).toHaveLength(1);
    expect(tracker.stats.incompleteHands).toBe(1);
  });

  it('counts failures and rethrows so the caller can apply a failure policy', async () => {
    const factory: LandmarkerFactory = () =>
      Promise.resolve({
        detectForVideo: () => {
          throw new Error('model exploded');
        },
        close: () => {},
      });
    const tracker = new HandTracker(makeOptions({ factory }));
    await tracker.init();

    expect(() => tracker.detect(fakeVideo, 0)).toThrow('model exploded');
    expect(tracker.stats.detectFailures).toBe(1);
  });

  it('releases the model and stops being ready after close()', async () => {
    const { factory, closed } = fakeFactory();
    const tracker = new HandTracker(makeOptions({ factory }));
    await tracker.init();

    tracker.close();

    expect(closed()).toBe(true);
    expect(tracker.ready).toBe(false);
    expect(() => tracker.detect(fakeVideo, 0)).toThrow();
  });
});

describe('CameraHandSource', () => {
  async function makeSource(factory: LandmarkerFactory) {
    const tracker = new HandTracker(makeOptions({ factory }));
    await tracker.init();
    return new CameraHandSource(tracker);
  }

  it('serves nothing before start() and nothing after stop()', async () => {
    const source = await makeSource(fakeFactory().factory);
    expect(source.frameAt(0)).toBeNull();

    source.start(0);
    source.detectNow(fakeVideo, 0);
    expect(source.frameAt(16)).not.toBeNull();

    source.stop();
    expect(source.frameAt(32)).toBeNull();
  });

  it('reports its frames as observed, never simulated', async () => {
    const source = await makeSource(fakeFactory().factory);
    source.start(0);
    source.detectNow(fakeVideo, 0);

    expect(source.provenance).toBe('observed');
    expect(source.frameAt(0)?.sourceId).toBe('camera');
  });

  it('counts renders between detections, per §7.2', async () => {
    const source = await makeSource(fakeFactory().factory);
    source.start(0);
    source.detectNow(fakeVideo, 0);

    source.frameAt(16);
    source.frameAt(32);
    source.frameAt(48);
    expect(source.framesDrawnSinceDetection).toBe(3);

    // A fresh detection resets the counter.
    source.detectNow(fakeVideo, 64);
    expect(source.framesDrawnSinceDetection).toBe(0);
  });

  it('marks the held hand stale once it is older than the configured limit', async () => {
    const source = await makeSource(fakeFactory().factory);
    source.start(0);
    source.detectNow(fakeVideo, 0);

    expect(source.isStale(10)).toBe(false);
    expect(source.msSinceDetection(10)).toBe(10);
    expect(source.isStale(10_000)).toBe(true);
  });

  /** A source whose detector throws while `shouldFail` is set. */
  async function failingSource(shouldFailInitially = true) {
    let shouldFail = shouldFailInitially;
    const factory: LandmarkerFactory = () =>
      Promise.resolve({
        detectForVideo: () => {
          if (shouldFail) throw new Error('transient');
          return detectedHand('Left');
        },
        close: () => {},
      });
    const source = await makeSource(factory);
    source.start(0);
    return {
      source,
      setFailing: (value: boolean) => {
        shouldFail = value;
      },
    };
  }

  it('does not give up on a fast burst of failures', async () => {
    // A GPU context loss or a shader recompile can throw several times in a row and
    // then recover. Disabling on the count alone would end the session's camera for
    // a transient fault — which looks, from the player's seat, like a crash.
    const { source } = await failingSource();

    for (let i = 0; i < INFERENCE.maxConsecutiveFailures + 2; i += 1) {
      const outcome = source.detectNow(fakeVideo, i);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.disabled).toBe(false);
    }
    expect(source.isDisabled).toBe(false);
    expect(source.consecutiveFailures).toBeGreaterThan(INFERENCE.maxConsecutiveFailures);
  });

  it('gives up once the failures also persist past the window', async () => {
    const { source } = await failingSource();

    // Enough failures, but not yet long enough.
    for (let i = 0; i < INFERENCE.maxConsecutiveFailures - 1; i += 1) {
      source.detectNow(fakeVideo, i);
    }
    const early = source.detectNow(fakeVideo, 1);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.disabled).toBe(false);

    const late = source.detectNow(fakeVideo, INFERENCE.failureWindowMs + 1);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.disabled).toBe(true);
    expect(source.isDisabled).toBe(true);

    // Once disabled it does no further work.
    const after = source.detectNow(fakeVideo, INFERENCE.failureWindowMs + 2);
    expect(after.ok).toBe(false);
  });

  it('a single success resets both the streak and the window', async () => {
    const { source, setFailing } = await failingSource();

    for (let i = 0; i < INFERENCE.maxConsecutiveFailures - 1; i += 1) {
      source.detectNow(fakeVideo, i);
    }
    setFailing(false);
    expect(source.detectNow(fakeVideo, 10).ok).toBe(true);
    expect(source.consecutiveFailures).toBe(0);

    // A new streak starts its own window, so an old failing timestamp cannot make
    // the next burst look like a persistent fault.
    setFailing(true);
    for (let i = 0; i < INFERENCE.maxConsecutiveFailures; i += 1) {
      const outcome = source.detectNow(fakeVideo, 20 + i);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.disabled).toBe(false);
    }
    expect(source.isDisabled).toBe(false);
  });

  it('clears the failure streak after a successful detection', async () => {
    let shouldFail = true;
    const factory: LandmarkerFactory = () =>
      Promise.resolve({
        detectForVideo: () => {
          if (shouldFail) throw new Error('transient');
          return detectedHand('Right');
        },
        close: () => {},
      });
    const source = await makeSource(factory);
    source.start(0);

    source.detectNow(fakeVideo, 0);
    source.detectNow(fakeVideo, 1);
    expect(source.consecutiveFailures).toBe(2);

    shouldFail = false;
    expect(source.detectNow(fakeVideo, 2).ok).toBe(true);
    expect(source.consecutiveFailures).toBe(0);
  });

  it('reports the session duration for reliability figures', async () => {
    const source = await makeSource(fakeFactory().factory);
    source.start(1000);
    expect(source.sessionMs(5000)).toBe(4000);
  });

  it('applies the configured handedness swap all the way through', async () => {
    const factory: LandmarkerFactory = () =>
      Promise.resolve({
        detectForVideo: () => detectedHand('Left'),
        close: () => {},
      });
    const tracker = new HandTracker(
      makeOptions({ factory, swapHandedness: true }),
    );
    await tracker.init();
    const source = new CameraHandSource(tracker);
    source.start(0);
    source.detectNow(fakeVideo, 0);

    const label: HandednessLabel | undefined =
      source.frameAt(0)?.hands[0]?.handedness.label;
    expect(label).toBe('Right');
  });
});
