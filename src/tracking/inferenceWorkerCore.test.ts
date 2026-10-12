/**
 * Unit tests for the worker's message handler.
 *
 * This is where all of the worker's logic lives, so it is tested without spawning a
 * worker, loading WASM, or having a browser. The two things worth being pedantic
 * about are the GPU → CPU fallback (the library rejects rather than degrading, so a
 * silent CPU worker is possible) and bitmap lifetime (one leaked `ImageBitmap` per
 * frame is a real leak at 20 fps).
 */

import { describe, expect, it, vi } from 'vitest';

import { LANDMARK_COUNT, type RawHandFrame } from './landmarkTypes';
import {
  initLandmarkerWithFallback,
  type DetectedHandLike,
  type HandLandmarkerConfig,
  type HandLandmarkerLike,
  type LandmarkerDelegate,
  type LandmarkerFactory,
} from './handTracker';
import {
  asImageSource,
  createInferenceHandler,
  type InferenceResponse,
} from './inferenceWorkerCore';

const CONFIG: HandLandmarkerConfig = {
  wasmBasePath: '/wasm',
  modelAssetPath: '/models/hand_landmarker.task',
  numHands: 2,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
};

function detectedHand(label: string): DetectedHandLike {
  return {
    landmarks: [
      Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.5 })),
    ],
    handedness: [[{ categoryName: label, score: 0.9 }]],
  };
}

/** A bitmap stand-in that records whether it was released. */
function fakeBitmap(closed = false) {
  return {
    width: 640,
    height: 480,
    closed,
    close(): void {
      this.closed = true;
    },
  };
}

interface Harness {
  responses: InferenceResponse[];
  handler: ReturnType<typeof createInferenceHandler>;
  detectCalls: () => number;
}

function makeHandler(
  options: {
    failOn?: ReadonlySet<LandmarkerDelegate>;
    detectThrows?: boolean;
    result?: DetectedHandLike;
  } = {},
): Harness {
  const responses: InferenceResponse[] = [];
  let detectCalls = 0;

  const factory: LandmarkerFactory = (delegate) => {
    if (options.failOn?.has(delegate)) {
      return Promise.reject(new Error(`${delegate} init failed`));
    }
    const landmarker: HandLandmarkerLike = {
      detectForVideo: () => {
        detectCalls += 1;
        if (options.detectThrows === true) throw new Error('model exploded');
        return options.result ?? detectedHand('Left');
      },
      close: () => {},
    };
    return Promise.resolve(landmarker);
  };

  const handler = createInferenceHandler({
    factory,
    post: (response) => responses.push(response),
    // A deterministic clock so the reported cost is assertable: 10 ms per call.
    now: (() => {
      let t = 0;
      return () => {
        t += 10;
        return t;
      };
    })(),
  });

  return { responses, handler, detectCalls: () => detectCalls };
}

const INIT = {
  type: 'init' as const,
  config: CONFIG,
  preferredDelegate: 'GPU' as const,
  swapHandedness: false,
};

describe('asImageSource', () => {
  it('accepts something bitmap-shaped and rejects everything else', () => {
    expect(asImageSource(fakeBitmap())).not.toBeNull();
    for (const bad of [null, undefined, 42, 'bitmap', {}, { close: () => {} }]) {
      expect(asImageSource(bad)).toBeNull();
    }
  });
});

describe('initLandmarkerWithFallback', () => {
  it('uses the preferred delegate and reports no fallback', async () => {
    const result = await initLandmarkerWithFallback(
      (_delegate) =>
        Promise.resolve({ detectForVideo: () => detectedHand('Left'), close: () => {} }),
      CONFIG,
      'GPU',
    );

    expect(result.delegate).toBe('GPU');
    expect(result.fellBack).toBe(false);
    expect(result.message).toBeNull();
  });

  it('falls back to CPU and records why, because the library does not', async () => {
    // MediaPipe's GPU init *rejects*; it does not silently degrade. So a worker that
    // quietly ran on CPU would otherwise look exactly like a GPU one.
    const result = await initLandmarkerWithFallback(
      (delegate) => {
        if (delegate === 'GPU') return Promise.reject(new Error('no WebGL'));
        return Promise.resolve({ detectForVideo: () => detectedHand('Left'), close: () => {} });
      },
      CONFIG,
      'GPU',
    );

    expect(result.delegate).toBe('CPU');
    expect(result.fellBack).toBe(true);
    expect(result.message).toContain('no WebGL');
  });

  it('rejects when every delegate fails', async () => {
    await expect(
      initLandmarkerWithFallback(
        () => Promise.reject(new Error('no wasm')),
        CONFIG,
        'GPU',
      ),
    ).rejects.toThrow(/no usable delegate/);
  });
});

describe('createInferenceHandler init', () => {
  it('reports ready with the delegate that actually initialised', async () => {
    const harness = makeHandler();
    await harness.handler.handle(INIT);

    expect(harness.responses).toEqual([
      { type: 'ready', delegate: 'GPU', fellBack: false, message: null },
    ]);
    expect(harness.handler.ready).toBe(true);
  });

  it('reports the fallback rather than hiding a CPU worker', async () => {
    const harness = makeHandler({ failOn: new Set(['GPU']) });
    await harness.handler.handle(INIT);

    expect(harness.responses[0]).toMatchObject({
      type: 'ready',
      delegate: 'CPU',
      fellBack: true,
    });
  });

  it('reports an init failure instead of throwing', async () => {
    const harness = makeHandler({ failOn: new Set(['GPU', 'CPU']) });
    await harness.handler.handle(INIT);

    expect(harness.responses[0]).toMatchObject({ type: 'init-error' });
    expect(harness.handler.ready).toBe(false);
  });

  it('rejects a malformed init request', async () => {
    const harness = makeHandler();
    await harness.handler.handle({ type: 'init' });

    expect(harness.responses[0]).toMatchObject({ type: 'init-error' });
  });
});

describe('createInferenceHandler detect', () => {
  async function readyHandler(options: Parameters<typeof makeHandler>[0] = {}) {
    const harness = makeHandler(options);
    await harness.handler.handle(INIT);
    harness.responses.length = 0;
    return harness;
  }

  it('maps hands and reports its own processing time', async () => {
    const harness = await readyHandler();
    const bitmap = fakeBitmap();

    await harness.handler.handle({ type: 'detect', id: 7, bitmap, timestampMs: 100 });

    expect(harness.responses).toHaveLength(1);
    const response = harness.responses[0];
    if (response?.type !== 'result') throw new Error('expected a result');
    expect(response.id).toBe(7);
    // `costMs` is the worker's own time, so it is comparable with the main thread.
    expect(response.costMs).toBe(10);
    const hands: RawHandFrame[] = response.hands;
    expect(hands).toHaveLength(1);
    expect(hands[0]?.handedness.label).toBe('Left');
  });

  it('applies the handedness swap it was initialised with', async () => {
    const harness = makeHandler();
    await harness.handler.handle({ ...INIT, swapHandedness: true });
    harness.responses.length = 0;

    await harness.handler.handle({ type: 'detect', id: 1, bitmap: fakeBitmap(), timestampMs: 0 });

    const response = harness.responses[0];
    if (response?.type !== 'result') throw new Error('expected a result');
    expect(response.hands[0]?.handedness.label).toBe('Right');
  });

  it('always releases the transferred bitmap, on success, on throw, and when unready', async () => {
    // One leaked ImageBitmap per frame is a real leak at ~20 fps.
    const success = await readyHandler();
    const good = fakeBitmap();
    await success.handler.handle({ type: 'detect', id: 1, bitmap: good, timestampMs: 0 });
    expect(good.closed).toBe(true);

    const throwing = await readyHandler({ detectThrows: true });
    const bad = fakeBitmap();
    await throwing.handler.handle({ type: 'detect', id: 1, bitmap: bad, timestampMs: 0 });
    expect(throwing.responses[0]).toMatchObject({ type: 'detect-error' });
    expect(bad.closed).toBe(true);

    const unready = makeHandler();
    const orphan = fakeBitmap();
    await unready.handler.handle({ type: 'detect', id: 1, bitmap: orphan, timestampMs: 0 });
    expect(unready.responses[0]).toMatchObject({ type: 'detect-error' });
    expect(orphan.closed).toBe(true);
  });

  it('rejects a detect with no usable bitmap', async () => {
    const harness = await readyHandler();
    await harness.handler.handle({ type: 'detect', id: 3, timestampMs: 0 });

    expect(harness.responses[0]).toMatchObject({ type: 'detect-error', id: 3 });
  });

  it('reports a model failure with the id, so the caller can correlate it', async () => {
    const harness = await readyHandler({ detectThrows: true });
    await harness.handler.handle({ type: 'detect', id: 9, bitmap: fakeBitmap(), timestampMs: 0 });

    expect(harness.responses[0]).toMatchObject({
      type: 'detect-error',
      id: 9,
      message: 'model exploded',
    });
  });

  it('does not call the model when it was never initialised', async () => {
    const harness = makeHandler();
    await harness.handler.handle({ type: 'detect', id: 1, bitmap: fakeBitmap(), timestampMs: 0 });

    expect(harness.detectCalls()).toBe(0);
  });
});

describe('createInferenceHandler protocol', () => {
  it('ignores a malformed request without throwing', async () => {
    const harness = makeHandler();
    for (const bad of [null, undefined, 42, 'nope']) {
      await harness.handler.handle(bad);
    }
    expect(harness.responses.every((r) => r.type === 'detect-error')).toBe(true);
  });

  it('reports an unknown request type rather than failing silently', async () => {
    const harness = makeHandler();
    await harness.handler.handle({ type: 'watch-the-skies' });

    expect(harness.responses[0]).toMatchObject({ type: 'detect-error' });
  });

  it('releases the model on close and on an explicit close request', async () => {
    const close = vi.fn();
    const handler = createInferenceHandler({
      factory: () =>
        Promise.resolve({ detectForVideo: () => detectedHand('Left'), close }),
      post: () => {},
    });
    await handler.handle(INIT);

    await handler.handle({ type: 'close' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(handler.ready).toBe(false);

    // Closing again must not double-release.
    handler.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
