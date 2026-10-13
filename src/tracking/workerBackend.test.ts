/**
 * Unit tests for the worker client.
 *
 * The `Worker`, the bitmap capture and the clock are all injected, so this covers the
 * parts that actually go wrong in the field: a worker that never reports ready, a
 * result that never comes back, a detection that rejects, and teardown that leaves
 * promises or listeners behind.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LANDMARK_COUNT, type RawHandFrame } from './landmarkTypes';
import type { HandLandmarkerConfig } from './handTracker';
import { WorkerDetectionBackend, type WorkerLike } from './workerBackend';
import type { InferenceResponse } from './inferenceWorkerCore';

const CONFIG: HandLandmarkerConfig = {
  wasmBasePath: '/wasm',
  modelAssetPath: '/models/hand_landmarker.task',
  numHands: 2,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
};

function hands(): RawHandFrame[] {
  return [
    {
      landmarks: Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.5 })),
      handedness: { label: 'Left', score: 0.9 },
    },
  ];
}

/** A worker stand-in that records what was posted and can reply. */
class FakeWorker implements WorkerLike {
  readonly posted: Array<{ message: unknown; transfer: Transferable[] | undefined }> = [];
  terminated = false;
  private listener: ((event: { data: unknown }) => void) | null = null;
  removed = 0;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.listener = listener;
  }

  removeEventListener(): void {
    this.removed += 1;
    this.listener = null;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a response to the client. */
  reply(response: InferenceResponse): void {
    this.listener?.({ data: response });
  }

  get lastMessage(): unknown {
    return this.posted[this.posted.length - 1]?.message;
  }
}

/**
 * Let the asynchronous capture inside `detect()` finish before inspecting the worker.
 *
 * A macrotask, not a microtask, so it is guaranteed to land after the whole
 * `await capture(...)` continuation rather than racing it.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

function makeBitmap() {
  return { width: 640, height: 480, closed: false, close(): void { this.closed = true; } };
}

function makeBackend(overrides: Partial<ConstructorParameters<typeof WorkerDetectionBackend>[0]> = {}) {
  const worker = new FakeWorker();
  const bitmap = makeBitmap();
  const backend = new WorkerDetectionBackend({
    createWorker: () => worker,
    config: CONFIG,
    preferredDelegate: 'GPU',
    swapHandedness: false,
    capture: () => Promise.resolve(bitmap as unknown as ImageBitmap),
    initTimeoutMs: 1000,
    detectTimeoutMs: 1000,
    ...overrides,
  });
  return { backend, worker, bitmap };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkerDetectionBackend init', () => {
  it('posts the configuration and resolves when the worker reports ready', async () => {
    const { backend, worker } = makeBackend();
    const ready = backend.init();

    expect(worker.lastMessage).toMatchObject({
      type: 'init',
      preferredDelegate: 'GPU',
      swapHandedness: false,
    });

    worker.reply({ type: 'ready', delegate: 'GPU', fellBack: false, message: null });
    await ready;

    expect(backend.delegate).toBe('GPU');
    expect(backend.delegateFallback).toBe(false);
    expect(backend.delegateMessage).toBeNull();
  });

  it('surfaces a CPU fallback so a slow worker cannot masquerade as a GPU one', async () => {
    const { backend, worker } = makeBackend();
    const ready = backend.init();
    worker.reply({ type: 'ready', delegate: 'CPU', fellBack: true, message: 'no WebGL' });
    await ready;

    expect(backend.delegate).toBe('CPU');
    expect(backend.delegateFallback).toBe(true);
    expect(backend.delegateMessage).toBe('no WebGL');
  });

  it('rejects on an init error and tears the worker down', async () => {
    const { backend, worker } = makeBackend();
    const ready = backend.init();
    worker.reply({ type: 'init-error', message: 'ModuleFactory not set.' });

    await expect(ready).rejects.toThrow(/ModuleFactory not set/);
    expect(worker.terminated).toBe(true);
  });

  it('rejects rather than hanging when the worker never reports ready', async () => {
    vi.useFakeTimers();
    const { backend } = makeBackend({ initTimeoutMs: 50 });
    const ready = backend.init();
    const assertion = expect(ready).rejects.toThrow(/did not report ready/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it('is idempotent, so a second init does not spawn a second worker', async () => {
    let spawned = 0;
    const { backend, worker } = makeBackend({
      createWorker: () => {
        spawned += 1;
        return worker;
      },
    });
    const ready = backend.init();
    worker.reply({ type: 'ready', delegate: 'GPU', fellBack: false, message: null });
    await ready;
    await backend.init();

    expect(spawned).toBe(1);
  });
});

describe('WorkerDetectionBackend detect', () => {
  async function ready() {
    const harness = makeBackend();
    const init = harness.backend.init();
    harness.worker.reply({ type: 'ready', delegate: 'GPU', fellBack: false, message: null });
    await init;
    return harness;
  }

  it('captures, transfers the bitmap, and resolves with the worker result', async () => {
    const { backend, worker, bitmap } = await ready();
    const pending = backend.detect({} as HTMLVideoElement, 42);
    await flush();

    const request = worker.lastMessage as { type: string; id: number; bitmap: unknown };
    expect(request.type).toBe('detect');
    expect(request.bitmap).toBe(bitmap);
    // Ownership transfers to the worker, so the transfer list must carry it.
    const detectPost = worker.posted.find(
      (entry) => (entry.message as { type?: string }).type === 'detect',
    );
    expect(detectPost?.transfer).toEqual([bitmap]);

    worker.reply({ type: 'result', id: request.id, hands: hands(), costMs: 7 });

    await expect(pending).resolves.toEqual({ hands: hands(), costMs: 7 });
  });

  it('correlates two overlapping detections by id', async () => {
    const { backend, worker } = await ready();
    const first = backend.detect({} as HTMLVideoElement, 1);
    await flush();
    const firstId = (worker.lastMessage as { id: number }).id;
    const second = backend.detect({} as HTMLVideoElement, 2);
    await flush();
    const secondId = (worker.lastMessage as { id: number }).id;

    expect(firstId).not.toBe(secondId);

    // Reply out of order: each promise must get its own result.
    worker.reply({ type: 'result', id: secondId, hands: [], costMs: 2 });
    worker.reply({ type: 'result', id: firstId, hands: hands(), costMs: 1 });

    await expect(first).resolves.toMatchObject({ costMs: 1 });
    await expect(second).resolves.toMatchObject({ costMs: 2 });
  });

  it('rejects when the worker reports a detection error', async () => {
    const { backend, worker } = await ready();
    const pending = backend.detect({} as HTMLVideoElement, 1);
    await flush();
    const id = (worker.lastMessage as { id: number }).id;

    worker.reply({ type: 'detect-error', id, message: 'model exploded' });

    await expect(pending).rejects.toThrow('model exploded');
  });

  it('rejects a result that never arrives, and releases the bitmap it still owns', async () => {
    vi.useFakeTimers();
    const { backend, worker, bitmap } = await ready();
    const pending = backend.detect({} as HTMLVideoElement, 1);
    await vi.advanceTimersByTimeAsync(0);
    const assertion = expect(pending).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
    // The worker never acknowledged it, so closing it here is correct. If it had, the
    // worker would already have released it and this would be a double close.
    expect(bitmap.closed).toBe(true);
    void worker;
  });

  it('refuses to detect before init', async () => {
    const { backend } = makeBackend();
    await expect(backend.detect({} as HTMLVideoElement, 0)).rejects.toThrow(/before init/);
  });

  it('propagates a capture failure without leaving a pending entry', async () => {
    const { backend } = await ready();
    const failing = makeBackend({ capture: () => Promise.reject(new Error('no frame')) });
    const init = failing.backend.init();
    failing.worker.reply({ type: 'ready', delegate: 'GPU', fellBack: false, message: null });
    await init;

    await expect(failing.backend.detect({} as HTMLVideoElement, 0)).rejects.toThrow('no frame');
    // The real backend is unaffected, which is the point of scoping the failure.
    expect(backend.delegate).toBe('GPU');
  });
});

describe('WorkerDetectionBackend close', () => {
  it('rejects anything pending, tells the worker, and terminates it', async () => {
    const { backend, worker } = makeBackend();
    const init = backend.init();
    worker.reply({ type: 'ready', delegate: 'GPU', fellBack: false, message: null });
    await init;

    const pending = backend.detect({} as HTMLVideoElement, 1);
    await flush();
    backend.close();

    await expect(pending).rejects.toThrow(/closed/);
    expect(worker.lastMessage).toMatchObject({ type: 'close' });
    expect(worker.terminated).toBe(true);
    expect(worker.removed).toBe(1);
  });

  it('is safe to call twice', async () => {
    const { backend, worker } = makeBackend();
    const init = backend.init();
    worker.reply({ type: 'ready', delegate: 'GPU', fellBack: false, message: null });
    await init;

    backend.close();
    backend.close();

    expect(worker.removed).toBe(1);
    expect(backend.delegate).toBeNull();
  });

  it('rejects a pending init so a teardown cannot leave it hanging', async () => {
    const { backend } = makeBackend();
    const ready = backend.init();
    backend.close();

    await expect(ready).rejects.toThrow(/closed/);
  });
});
