/**
 * Unit tests for camera capture and the permission-failure taxonomy.
 *
 * The taxonomy is the part that matters for §13 M1: a denied camera must not be a
 * dead end, so every reason has to be distinguishable and every message has to lead
 * somewhere. Each case is asserted to name the simulator, which is exactly what
 * "no dead end" means in practice.
 *
 * The platform surface is injected, so there is no DOM and no camera here.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  browserCameraEnvironment,
  classifyCameraError,
  insecureContextFailure,
  startCamera,
  stopStream,
  unsupportedFailure,
  type CameraEnvironment,
  type CameraFailureReason,
  type MediaStreamLike,
  type VideoSurface,
} from './camera';

/** A video element stand-in that records listener registration. */
class FakeVideo implements VideoSurface {
  srcObject: unknown = null;
  playsInline = false;
  muted = false;
  autoplay = false;
  videoWidth = 640;
  videoHeight = 480;
  playResult: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<string, Set<() => void>>();

  play(): Promise<void> {
    return this.playResult;
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Fire a registered listener, as the browser would. */
  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

function makeStream(trackCount = 1): { stream: MediaStreamLike; stops: ReturnType<typeof vi.fn>[] } {
  const stops = Array.from({ length: trackCount }, () => vi.fn());
  return { stream: { getTracks: () => stops.map((stop) => ({ stop })) }, stops };
}

interface HarnessOptions {
  secure?: boolean;
  hasApi?: boolean;
  getUserMedia?: CameraEnvironment<FakeVideo>['mediaDevices'] extends infer _T
    ? (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>
    : never;
}

function makeEnvironment(video: FakeVideo, options: HarnessOptions = {}) {
  const { secure = true, hasApi = true } = options;
  const getUserMedia = options.getUserMedia ?? (() => Promise.resolve(makeStream().stream));
  const environment: CameraEnvironment<FakeVideo> = {
    mediaDevices: hasApi ? { getUserMedia } : undefined,
    isSecureContext: secure,
    createVideo: () => video,
  };
  return environment;
}

describe('classifyCameraError', () => {
  const cases: Array<[string, CameraFailureReason]> = [
    ['NotAllowedError', 'denied'],
    ['PermissionDeniedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'not-found'],
    ['DevicesNotFoundError', 'not-found'],
    ['NotReadableError', 'in-use'],
    ['TrackStartError', 'in-use'],
    ['AbortError', 'in-use'],
    ['OverconstrainedError', 'overconstrained'],
    ['ConstraintNotSatisfiedError', 'overconstrained'],
    ['SomethingElse', 'unknown'],
  ];

  it.each(cases)('maps %s to %s', (name, reason) => {
    expect(classifyCameraError({ name })).toMatchObject({ reason });
  });

  it('maps a real DOMException-like Error by name, not by instanceof', () => {
    // Cross-realm DOMExceptions are not reliably `instanceof`, so name matching is
    // the only dependable signal.
    const error = new Error('denied');
    error.name = 'NotAllowedError';
    expect(classifyCameraError(error).reason).toBe('denied');
  });

  it('handles a thrown non-object without throwing', () => {
    for (const thrown of [null, undefined, 'nope', 42]) {
      expect(classifyCameraError(thrown).reason).toBe('unknown');
    }
  });

  it('always gives a message that offers a way to play', () => {
    // §13 M1: camera denial must never be a dead end. Every reason has to say so.
    for (const [, reason] of cases) {
      const failure = classifyCameraError({ name: cases.find(([, r]) => r === reason)?.[0] });
      expect(failure.message.length).toBeGreaterThan(0);
      expect(failure.message.toLowerCase()).toContain('simulator');
    }
    for (const failure of [insecureContextFailure(), unsupportedFailure()]) {
      expect(failure.message.toLowerCase()).toContain('simulator');
    }
  });

  it('names the secure-context and unsupported reasons distinctly', () => {
    expect(insecureContextFailure().reason).toBe('insecure-context');
    expect(unsupportedFailure().reason).toBe('unsupported');
  });
});

describe('startCamera', () => {
  it('refuses on an insecure context before touching getUserMedia', async () => {
    const getUserMedia = vi.fn();
    const result = await startCamera(
      makeEnvironment(new FakeVideo(), { secure: false, getUserMedia }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('insecure-context');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('reports an unsupported browser on a secure context with no camera API', async () => {
    const result = await startCamera(makeEnvironment(new FakeVideo(), { hasApi: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('unsupported');
  });

  it('requests a user-facing video stream and no audio', async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(makeStream().stream));
    await startCamera(makeEnvironment(new FakeVideo(), { getUserMedia }));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints;
    expect(constraints.audio).toBe(false);
    expect(constraints.video).toMatchObject({ facingMode: 'user' });
  });

  it('returns the stream and the intrinsic dimensions on success', async () => {
    const video = new FakeVideo();
    video.videoWidth = 1280;
    video.videoHeight = 720;
    const { stream } = makeStream(2);

    const result = await startCamera(makeEnvironment(video, { getUserMedia: () => Promise.resolve(stream) }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.width).toBe(1280);
      expect(result.height).toBe(720);
      expect(result.stream).toBe(stream);
      expect(result.video).toBe(video);
    }
    // The stream is attached before play(), so the first frame is not lost.
    expect(video.srcObject).toBe(stream);
  });

  it('waits for metadata when dimensions are not yet known', async () => {
    const video = new FakeVideo();
    video.videoWidth = 0;
    video.videoHeight = 0;

    const pending = startCamera(makeEnvironment(video), { timeoutMs: 1000 });
    // The stream is granted, then the element reports its size.
    await Promise.resolve();
    video.videoWidth = 640;
    video.videoHeight = 480;
    video.emit('loadedmetadata');

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.width).toBe(640);
    // Listeners are cleaned up, so a later rotation does not call into a dead path.
    expect(video.listenerCount).toBe(0);
  });

  it('fails when the stream never produces a picture, and releases the camera', async () => {
    const video = new FakeVideo();
    video.videoWidth = 0;
    video.videoHeight = 0;
    const { stream, stops } = makeStream();

    const result = await startCamera(
      makeEnvironment(video, { getUserMedia: () => Promise.resolve(stream) }),
      { timeoutMs: 1 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain('never sent a picture');
    // A granted-but-dead camera must not leave the light on.
    expect(stops[0]).toHaveBeenCalled();
    expect(video.listenerCount).toBe(0);
  });

  it('fails and releases the camera when play() rejects', async () => {
    const video = new FakeVideo();
    video.playResult = Promise.reject(new Error('autoplay blocked'));
    const { stream, stops } = makeStream();

    const result = await startCamera(
      makeEnvironment(video, { getUserMedia: () => Promise.resolve(stream) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain('would not play');
    expect(stops[0]).toHaveBeenCalled();
  });

  it('surfaces a getUserMedia rejection as a classified failure, not a throw', async () => {
    const result = await startCamera(
      makeEnvironment(new FakeVideo(), {
        getUserMedia: () => Promise.reject(Object.assign(new Error('nope'), { name: 'NotFoundError' })),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('not-found');
  });
});

describe('stopStream', () => {
  it('stops every track', () => {
    const { stream, stops } = makeStream(3);
    stopStream(stream);
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });

  it('tolerates null, undefined and a throwing track', () => {
    expect(() => stopStream(null)).not.toThrow();
    expect(() => stopStream(undefined)).not.toThrow();
    expect(() =>
      stopStream({
        getTracks: () => [
          {
            stop: () => {
              throw new Error('already ended');
            },
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe('browserCameraEnvironment', () => {
  it('does not reach for the DOM until createVideo is called', () => {
    // The environment is constructed at startup, before any user gesture, so it
    // must not create elements or touch the camera eagerly.
    const environment = browserCameraEnvironment();
    expect(typeof environment.createVideo).toBe('function');
    expect(typeof environment.isSecureContext).toBe('boolean');
  });
});
