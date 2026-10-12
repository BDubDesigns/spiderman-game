/**
 * Unit tests for camera capture, playback, and the failure taxonomy.
 *
 * Two things are load-bearing here.
 *
 * First, the taxonomy: a denied camera must not be a dead end, so every camera
 * reason has to be distinguishable and every message has to lead somewhere.
 *
 * Second — and this is why the file grew — playback is the step that failed on a
 * real device while `getUserMedia` succeeded, and the reason was silently
 * discarded. The tests below pin down that a rejection's `name` and `message`
 * survive all the way to the player-facing failure, that a gesture-recoverable
 * failure keeps the stream alive so a click can finish the job, and that every
 * other failure path actually releases the camera.
 *
 * The platform surface is injected, so there is no DOM and no camera here.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  acquireCamera,
  beginPlayback,
  browserCameraEnvironment,
  classifyCameraError,
  createStartGuard,
  describePlaybackError,
  formatDiagnostic,
  insecureContextFailure,
  releaseCamera,
  startCamera,
  stopStream,
  unsupportedFailure,
  type CameraEnvironment,
  type CameraFailureReason,
  type MediaStreamLike,
  type VideoSurface,
} from './camera';

/** A video element stand-in that records what was done to it. */
class FakeVideo implements VideoSurface {
  srcObject: unknown = null;
  playsInline = false;
  muted = false;
  autoplay = false;
  videoWidth = 640;
  videoHeight = 480;
  paused = true;

  readonly attributes = new Map<string, string>();
  readonly events: string[] = [];
  /** Widths observed at each `play()` call, to prove metadata was awaited first. */
  readonly playObservedWidths: number[] = [];
  playCalls = 0;
  mounted = false;

  /** Overridden per test to control playback. Resolving implies frames started. */
  playImpl: () => Promise<void> = () => {
    this.paused = false;
    return Promise.resolve();
  };

  private readonly listeners = new Map<string, Set<() => void>>();

  play(): Promise<void> {
    this.playCalls += 1;
    this.playObservedWidths.push(this.videoWidth);
    this.events.push('play');
    return this.playImpl();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
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

function rejection(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function makeStream(trackCount = 1): {
  stream: MediaStreamLike;
  stops: ReturnType<typeof vi.fn>[];
} {
  const stops = Array.from({ length: trackCount }, () => vi.fn());
  return { stream: { getTracks: () => stops.map((stop) => ({ stop })) }, stops };
}

interface HarnessOptions {
  secure?: boolean;
  hasApi?: boolean;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>;
}

function makeEnvironment(video: FakeVideo, options: HarnessOptions = {}) {
  const { secure = true, hasApi = true } = options;
  const getUserMedia =
    options.getUserMedia ?? (() => Promise.resolve(makeStream().stream));
  const environment: CameraEnvironment<FakeVideo> = {
    mediaDevices: hasApi ? { getUserMedia } : undefined,
    isSecureContext: secure,
    createVideo: () => video,
    mountVideo: (element) => {
      element.mounted = true;
      element.events.push('mount');
    },
    unmountVideo: (element) => {
      element.mounted = false;
      element.events.push('unmount');
    },
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
    expect(classifyCameraError(rejection('NotAllowedError', 'denied')).reason).toBe(
      'denied',
    );
  });

  it('handles a thrown non-object without throwing', () => {
    for (const thrown of [null, undefined, 'nope', 42]) {
      expect(classifyCameraError(thrown).reason).toBe('unknown');
    }
  });

  it('always gives a message that offers a way to play', () => {
    // §13 M1: camera denial must never be a dead end. Every reason has to say so.
    for (const [name] of cases) {
      const failure = classifyCameraError({ name });
      expect(failure.message.length).toBeGreaterThan(0);
      expect(failure.message.toLowerCase()).toContain('simulator');
      expect(failure.recovery).toBe('simulator');
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

describe('playback diagnostics', () => {
  it('preserves the error name and message verbatim', () => {
    const diagnostic = describePlaybackError(
      rejection('NotAllowedError', "play() failed because the user didn't interact"),
    );
    expect(diagnostic).toEqual({
      name: 'NotAllowedError',
      message: "play() failed because the user didn't interact",
      playingAnyway: false,
    });
  });

  it('does not invent detail for a rejection that carries none', () => {
    const diagnostic = describePlaybackError('just a string');
    expect(diagnostic.name).toBe('');
    expect(diagnostic.message).toBe('just a string');
    expect(formatDiagnostic(diagnostic)).toBe('Error: just a string');
  });

  it('says so explicitly when there is nothing to report', () => {
    expect(formatDiagnostic(describePlaybackError({}))).toBe(
      'no error detail was provided',
    );
  });

  it('renders a copyable one-liner', () => {
    expect(
      formatDiagnostic(describePlaybackError(rejection('AbortError', 'interrupted'))),
    ).toBe('AbortError: interrupted');
  });
});

describe('acquireCamera', () => {
  it('refuses on an insecure context before touching getUserMedia', async () => {
    const getUserMedia = vi.fn();
    const result = await acquireCamera(
      makeEnvironment(new FakeVideo(), { secure: false, getUserMedia }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('insecure-context');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('reports an unsupported browser on a secure context with no camera API', async () => {
    const result = await acquireCamera(
      makeEnvironment(new FakeVideo(), { hasApi: false }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('unsupported');
  });

  it('requests a user-facing video stream and no audio', async () => {
    // The parameter is declared even though it is unused, so the mock's call tuple
    // is indexable and the assertions below need no cast.
    const getUserMedia = vi.fn((_constraints: MediaStreamConstraints) =>
      Promise.resolve(makeStream().stream),
    );
    await acquireCamera(makeEnvironment(new FakeVideo(), { getUserMedia }));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0]?.[0];
    expect(constraints?.audio).toBe(false);
    expect(constraints?.video).toMatchObject({ facingMode: 'user' });
  });

  it('mounts the element before attaching the stream', async () => {
    // A detached element is outside the normal rendering path, which is the first
    // suspect for playback refusing to start.
    const video = new FakeVideo();
    const result = await acquireCamera(makeEnvironment(video));

    expect(result.ok).toBe(true);
    expect(video.mounted).toBe(true);
    expect(video.events).toEqual(['mount']);
  });

  it('returns the stream and the intrinsic dimensions', async () => {
    const video = new FakeVideo();
    video.videoWidth = 1280;
    video.videoHeight = 720;
    const { stream } = makeStream(2);

    const result = await acquireCamera(
      makeEnvironment(video, { getUserMedia: () => Promise.resolve(stream) }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.width).toBe(1280);
      expect(result.session.height).toBe(720);
      expect(result.session.stream).toBe(stream);
      expect(result.session.video).toBe(video);
    }
    expect(video.srcObject).toBe(stream);
  });

  it('waits for metadata when dimensions are not yet known', async () => {
    const video = new FakeVideo();
    video.videoWidth = 0;
    video.videoHeight = 0;

    const pending = acquireCamera(makeEnvironment(video), { timeoutMs: 1000 });
    await Promise.resolve();
    video.videoWidth = 640;
    video.videoHeight = 480;
    video.emit('loadedmetadata');

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.width).toBe(640);
    // Listeners are cleaned up, so a later resize does not call into a dead path.
    expect(video.listenerCount).toBe(0);
  });

  it('fails a silent stream without leaking the camera or the element', async () => {
    const video = new FakeVideo();
    video.videoWidth = 0;
    video.videoHeight = 0;
    const { stream, stops } = makeStream();

    const result = await acquireCamera(
      makeEnvironment(video, { getUserMedia: () => Promise.resolve(stream) }),
      { timeoutMs: 1 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe('stream-unusable');
      expect(result.failure.message).toContain('never sent a picture');
    }
    // A granted-but-dead camera must not leave the light on or the element mounted.
    expect(stops[0]).toHaveBeenCalled();
    expect(video.mounted).toBe(false);
    expect(video.listenerCount).toBe(0);
  });

  it('surfaces a getUserMedia rejection as a classified failure, not a throw', async () => {
    const result = await acquireCamera(
      makeEnvironment(new FakeVideo(), {
        getUserMedia: () => Promise.reject(rejection('NotFoundError', 'no device')),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('not-found');
  });
});

describe('beginPlayback', () => {
  it('succeeds and reports no diagnostic when playback starts', async () => {
    const video = new FakeVideo();
    const outcome = await beginPlayback(video);

    expect(outcome.ok).toBe(true);
    expect(video.playCalls).toBe(1);
  });

  it('does not call play() when the autoplay attribute already started it', async () => {
    // Calling play() on an element that is already playing is itself a way to
    // provoke an AbortError, so it is deliberately not called.
    const video = new FakeVideo();
    video.paused = false;

    const outcome = await beginPlayback(video);

    expect(outcome.ok).toBe(true);
    expect(video.playCalls).toBe(0);
  });

  it('preserves the rejection name and message, and asks for a gesture retry', async () => {
    const video = new FakeVideo();
    video.playImpl = () =>
      Promise.reject(
        rejection('NotAllowedError', "play() failed because the user didn't interact"),
      );

    const outcome = await beginPlayback(video);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('playback-blocked');
      expect(outcome.failure.recovery).toBe('user-gesture');
      // The browser's own words survive into the player-facing message.
      expect(outcome.failure.message).toContain('NotAllowedError');
      expect(outcome.failure.message).toContain(
        "play() failed because the user didn't interact",
      );
      expect(outcome.failure.message).toContain('simulator');
      expect(outcome.failure.diagnostic).toEqual({
        name: 'NotAllowedError',
        message: "play() failed because the user didn't interact",
        playingAnyway: false,
      });
    }
  });

  it('classifies a non-policy rejection as playback-failed but still offers a retry', async () => {
    const video = new FakeVideo();
    video.playImpl = () => Promise.reject(rejection('NotSupportedError', 'no source'));

    const outcome = await beginPlayback(video);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('playback-failed');
      expect(outcome.failure.recovery).toBe('user-gesture');
      expect(outcome.failure.diagnostic?.name).toBe('NotSupportedError');
    }
  });

  it('treats an AbortError that left the element playing as success', async () => {
    // The documented meaning of this rejection is that a newer play/load superseded
    // the request. Reporting a failure here would be wrong.
    const video = new FakeVideo();
    video.playImpl = () => {
      video.paused = false;
      return Promise.reject(rejection('AbortError', 'interrupted by a new load request'));
    };

    const outcome = await beginPlayback(video);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.diagnostic?.name).toBe('AbortError');
      expect(outcome.diagnostic?.playingAnyway).toBe(true);
    }
  });

  it('bounds a play() promise that never settles', async () => {
    const video = new FakeVideo();
    video.playImpl = () => new Promise<void>(() => {});

    const outcome = await beginPlayback(video, { timeoutMs: 5 });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('playback-failed');
      expect(outcome.failure.diagnostic?.name).toBe('TimeoutError');
      expect(outcome.failure.message).toContain('did not begin');
    }
  });
});

describe('startCamera', () => {
  it('waits for a picture before playing, so playback is not racing the load', async () => {
    const video = new FakeVideo();
    video.videoWidth = 0;
    video.videoHeight = 0;

    const pending = startCamera(makeEnvironment(video), { timeoutMs: 1000 });
    await Promise.resolve();
    video.videoWidth = 640;
    video.videoHeight = 480;
    video.emit('loadedmetadata');
    await pending;

    // play() was only ever called with real dimensions known.
    expect(video.playObservedWidths).toEqual([640]);
    expect(video.events).toEqual(['mount', 'play']);
  });

  it('reports success with no diagnostic on the happy path', async () => {
    const video = new FakeVideo();
    const result = await startCamera(makeEnvironment(video));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.width).toBe(640);
      expect(result.diagnostic).toBeNull();
    }
  });

  it('keeps the stream alive and returns a resumable session when playback is blocked', async () => {
    const video = new FakeVideo();
    const { stream, stops } = makeStream();
    video.playImpl = () => Promise.reject(rejection('NotAllowedError', 'blocked'));

    const result = await startCamera(
      makeEnvironment(video, { getUserMedia: () => Promise.resolve(stream) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('playback-blocked');
    expect(result.pending).toBeDefined();
    expect(result.pending?.video).toBe(video);
    // Crucially: the camera is NOT released, because a click can still fix this.
    expect(stops[0]).not.toHaveBeenCalled();
    expect(video.mounted).toBe(true);
  });

  it('releases the camera when playback fails unrecoverably', async () => {
    const video = new FakeVideo();
    video.videoWidth = 0;
    video.videoHeight = 0;
    const { stream, stops } = makeStream();

    const result = await startCamera(
      makeEnvironment(video, { getUserMedia: () => Promise.resolve(stream) }),
      { timeoutMs: 1 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.pending).toBeUndefined();
    expect(stops[0]).toHaveBeenCalled();
    expect(video.mounted).toBe(false);
  });
});

describe('PendingPlayback recovery', () => {
  async function blockedSession() {
    const video = new FakeVideo();
    const { stream, stops } = makeStream();
    video.playImpl = () => Promise.reject(rejection('NotAllowedError', 'blocked'));

    const result = await startCamera(
      makeEnvironment(video, { getUserMedia: () => Promise.resolve(stream) }),
    );
    if (result.ok || !result.pending) throw new Error('expected a pending playback');
    return { video, stops, pending: result.pending };
  }

  it('resumes successfully once the gesture-clicked play() is allowed', async () => {
    const { video, stops, pending } = await blockedSession();
    expect(stops[0]).not.toHaveBeenCalled();

    // The retry happens inside a real click in the app; here it just succeeds.
    video.playImpl = () => {
      video.paused = false;
      return Promise.resolve();
    };
    const outcome = await pending.resume();

    expect(outcome.ok).toBe(true);
    expect(video.playCalls).toBe(2);
    expect(video.paused).toBe(false);
    // The stream was never torn down, so no second permission prompt.
    expect(stops[0]).not.toHaveBeenCalled();
    expect(pending.video).toBe(video);
  });

  it('reports the new diagnostic when the retry also fails', async () => {
    const { pending } = await blockedSession();

    const outcome = await pending.resume();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.diagnostic?.name).toBe('NotAllowedError');
      expect(outcome.failure.recovery).toBe('user-gesture');
    }
  });

  it('release() stops the tracks, detaches the stream and unmounts the element', async () => {
    const { video, stops, pending } = await blockedSession();

    pending.release();

    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(video.mounted).toBe(false);
    expect(video.events).toContain('unmount');
  });

  it('is idempotent: releasing twice does not double-stop', async () => {
    const { stops, pending } = await blockedSession();

    pending.release();
    pending.release();

    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  it('refuses to resume after release, rather than playing a dead stream', async () => {
    const { pending } = await blockedSession();
    pending.release();

    const outcome = await pending.resume();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.reason).toBe('stream-unusable');
  });
});

describe('releaseCamera', () => {
  it('tolerates null and undefined', () => {
    const environment = makeEnvironment(new FakeVideo());
    expect(() => releaseCamera(environment, null)).not.toThrow();
    expect(() => releaseCamera(environment, undefined)).not.toThrow();
  });

  it('stops every track and unmounts, even when a track throws', () => {
    const video = new FakeVideo();
    const environment = makeEnvironment(video);
    let unmounted = 0;
    environment.unmountVideo = () => {
      unmounted += 1;
    };

    releaseCamera(environment, {
      video,
      stream: {
        getTracks: () => [
          {
            stop: () => {
              throw new Error('already ended');
            },
          },
        ],
      },
    });

    expect(unmounted).toBe(1);
    expect(video.srcObject).toBeNull();
  });
});

describe('createStartGuard', () => {
  it('admits one start at a time', () => {
    const guard = createStartGuard();
    expect(guard.busy).toBe(false);

    expect(guard.tryEnter()).toBe(true);
    expect(guard.busy).toBe(true);
    // A second press while starting must not issue another getUserMedia call.
    expect(guard.tryEnter()).toBe(false);

    guard.exit();
    expect(guard.busy).toBe(false);
    expect(guard.tryEnter()).toBe(true);
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
  it('does not reach for the document until an element is created and mounted', () => {
    // Constructed at startup, before any user gesture, and built in tests that have
    // no DOM at all — so constructing it must be inert.
    const environment = browserCameraEnvironment();
    expect(typeof environment.createVideo).toBe('function');
    expect(typeof environment.mountVideo).toBe('function');
    expect(typeof environment.isSecureContext).toBe('boolean');
  });
});
