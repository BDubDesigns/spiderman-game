/**
 * Camera capture: `getUserMedia`, the video element, playback, and failures.
 *
 * PLAN.md §13 M1 requires camera denial to be handled here, and §15 risk 13
 * requires it not be deferred: a denied camera must offer the M0 simulator as a
 * playable option, never a dead end.
 *
 * ---- Testability ----
 *
 * Nothing in this module reaches for a global. The platform surface it needs is
 * injected as a {@link CameraEnvironment}, and the video element is whatever the
 * environment's factory returns, so the whole module is unit-testable with no DOM
 * and no camera. `browserCameraEnvironment()` is the one function that touches
 * real globals.
 *
 * ---- Why playback is a separate, retryable step ----
 *
 * `getUserMedia()` succeeding does not mean the frames will be displayed. An
 * element can have a live stream attached and still refuse to play, and in Chrome
 * one class of those refusals — a policy refusal — is only resolvable from inside
 * a real user gesture.
 *
 * So acquisition and playback are separate operations with separate outcomes:
 * {@link acquireCamera} gets permission and a ready element, {@link beginPlayback}
 * starts it and reports *why* if it will not start. {@link startCamera} composes
 * them for the one-shot case, and when playback fails in a way a click could fix it
 * returns a {@link PendingPlayback} that keeps the stream alive and exposes
 * `resume()` for a button handler to call inside a genuine activation.
 *
 * ---- Diagnostics are never discarded ----
 *
 * Every platform rejection is preserved verbatim in
 * {@link PlaybackDiagnostic}: the browser's own `name` and `message`. They are
 * shown to the player and kept in the HUD, because the alternative — a generic
 * "would not play" — makes a real failure undiagnosable. Nothing here invents a
 * message for an error it did not receive.
 */

import { CAMERA } from '../config';

/** The parts of `MediaStream` this module uses. */
export interface MediaStreamLike {
  getTracks(): Array<{ stop(): void }>;
}

/**
 * The parts of `HTMLVideoElement` this module uses.
 *
 * Declared structurally so `HTMLVideoElement` satisfies it unchanged while tests
 * can pass a plain object. `srcObject` is write-only here and typed `unknown` to
 * keep the interface structural rather than dragging in `MediaProvider`.
 */
export interface VideoSurface {
  srcObject: unknown;
  playsInline: boolean;
  muted: boolean;
  autoplay: boolean;
  readonly paused: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  play(): Promise<void>;
  /** Content attributes, which are not always interchangeable with IDL properties. */
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The parts of `MediaDevices` this module uses. */
export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
}

/** Everything this module needs from the platform. */
export interface CameraEnvironment<V extends VideoSurface = VideoSurface> {
  mediaDevices: MediaDevicesLike | undefined;
  isSecureContext: boolean;
  /** Create the (detached) element the stream will be attached to. */
  createVideo(): V;
  /**
   * Put the element in the document.
   *
   * Required, not cosmetic. An element that is not in a document is outside the
   * normal rendering path, and Chrome's playback behaviour for such an element is
   * not something to depend on. Every production `getUserMedia` pipeline mounts
   * its element, and this one did not — which is the first thing that changed here.
   *
   * The implementation must keep the element *rendered* (real box, composited)
   * while invisible. `display: none` and zero-sized elements can suppress frame
   * delivery, so hiding is done with opacity, never by removing it from layout.
   */
  mountVideo(video: V): void;
  /** Remove the element again. Must tolerate an element that was never mounted. */
  unmountVideo(video: V): void;
}

/** The container the camera element is mounted into, when one is supplied. */
export function browserCameraEnvironment(
  container?: HTMLElement,
): CameraEnvironment<HTMLVideoElement> {
  // The host is resolved lazily, at mount time. Constructing this environment must
  // not touch the document at all, so that building one is safe before any user
  // gesture and testable outside a browser.
  const resolveHost = (): HTMLElement => container ?? document.body;
  return {
    // Browser-only entry point, so `navigator` is assumed present; the injected
    // environment is what makes the rest of this module testable without it.
    mediaDevices: globalThis.navigator.mediaDevices,
    isSecureContext: globalThis.isSecureContext === true,
    createVideo: () => {
      const video = document.createElement('video');
      // Set BOTH the property and the content attribute. They are not always
      // interchangeable: `muted` in particular has a `defaultMuted` distinction,
      // and attribute-vs-property timing relative to the resource selection
      // algorithm is a known source of "it works on my machine" playback bugs.
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.setAttribute('autoplay', '');
      return video;
    },
    mountVideo: (video) => {
      // Invisible but genuinely laid out. `opacity: 0` keeps the element in the
      // render tree, which `display: none` would not.
      video.style.position = 'absolute';
      video.style.inset = '0';
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.opacity = '0';
      video.style.pointerEvents = 'none';
      resolveHost().appendChild(video);
    },
    unmountVideo: (video) => {
      video.remove();
    },
  };
}

/**
 * Why the camera is unavailable.
 *
 * Every one of these is recoverable by playing with the simulator, which is why
 * there is no "no fallback possible" case.
 */
export type CameraFailureReason =
  /** No `mediaDevices` API at all. */
  | 'unsupported'
  /** HTTPS (or localhost) is required; the page is on plain HTTP. */
  | 'insecure-context'
  /** The player declined, or policy blocked it. */
  | 'denied'
  /** No camera device is attached. */
  | 'not-found'
  /** Another application or tab holds the camera. */
  | 'in-use'
  /** The requested constraints cannot be satisfied. */
  | 'overconstrained'
  /** A live stream that supposedly cannot be used at all. */
  | 'stream-unusable'
  /**
   * The stream is live and the element is ready, but the browser refused to start
   * playback for a policy reason. A real user gesture may still succeed.
   */
  | 'playback-blocked'
  /** Playback could not be started for some other reason, or timed out. */
  | 'playback-failed'
  | 'unknown';

/** What the player can do about a failure. */
export type FailureRecovery =
  /** Nothing but a different input source. */
  | 'simulator'
  /** A direct click may still start playback, so the UI must offer a button. */
  | 'user-gesture';

/**
 * The browser's own account of what went wrong, preserved verbatim.
 *
 * `name` and `message` are copied, never rephrased. An empty `name` means the
 * rejection was not an error-shaped value at all, which is itself information.
 */
export interface PlaybackDiagnostic {
  name: string;
  message: string;
  /** The element was actually playing despite the rejection. */
  playingAnyway: boolean;
}

export interface CameraFailure {
  reason: CameraFailureReason;
  /** Player-facing, non-technical, and always leads somewhere. */
  message: string;
  /** Verbatim platform diagnostics, when the failure came from the platform. */
  diagnostic?: PlaybackDiagnostic;
  /** What the UI should offer. */
  recovery: FailureRecovery;
}

/**
 * The minimum a session must expose in order to be released.
 *
 * Narrower than a full session on purpose: cleanup needs the stream and the
 * element, and nothing about dimensions, so a caller holding only part of a
 * session can still release it correctly.
 */
export interface ReleasableSession<V extends VideoSurface = VideoSurface> {
  stream: MediaStreamLike;
  video: V;
}

/** A stream that is live and attached, but not necessarily playing yet. */
export interface CameraSessionParts<V extends VideoSurface = VideoSurface>
  extends ReleasableSession<V> {
  width: number;
  height: number;
}

/**
 * A camera that is acquired and has delivered a picture, but would not start
 * playing.
 *
 * The stream is deliberately still live: the whole point is that a direct click
 * can finish the job without re-prompting for permission. `release()` must be
 * called if the player gives up, and the caller must not leave one of these
 * un-released — that is a camera light left on.
 */
export interface PendingPlayback<V extends VideoSurface = VideoSurface>
  extends CameraSessionParts<V> {
  /**
   * Retry playback and confirm a picture arrived.
   *
   * Call from a genuine user-gesture handler; never synthesize an activation.
   */
  resume(): Promise<ResumeOutcome>;
  /** Stop the stream and remove the element. */
  release(): void;
}

export type PlaybackOutcome =
  | { ok: true; diagnostic: PlaybackDiagnostic | null }
  | { ok: false; failure: CameraFailure };

/**
 * The result of retrying playback on a {@link PendingPlayback}.
 *
 * Carries the confirmed dimensions, because a session that had no picture before
 * the retry may well have one after it.
 */
export type ResumeOutcome =
  | {
      ok: true;
      diagnostic: PlaybackDiagnostic | null;
      width: number;
      height: number;
    }
  | { ok: false; failure: CameraFailure };

export type CameraResult<V extends VideoSurface = VideoSurface> =
  | ({ ok: true; diagnostic: PlaybackDiagnostic | null } & CameraSessionParts<V>)
  | {
      ok: false;
      failure: CameraFailure;
      /** Present when the failure is worth retrying in place with a click. */
      pending?: PendingPlayback<V>;
    };

/**
 * Map a thrown value to a failure. Pure, so the whole taxonomy is unit-tested.
 *
 * The DOM exception names are checked by name rather than by `instanceof`,
 * because `DOMException` is not reliable across realms and some browsers throw
 * plain objects with a legacy `name` (e.g. `TrackStartError`).
 */
export function classifyCameraError(error: unknown): CameraFailure {
  const { name } = describeThrown(error);

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        reason: 'denied',
        recovery: 'simulator',
        message:
          'Camera access is blocked. You can allow it in your browser settings and reload, or play with the hand simulator instead.',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        reason: 'not-found',
        recovery: 'simulator',
        message:
          'No camera was found on this device. You can play with the hand simulator instead.',
      };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        reason: 'in-use',
        recovery: 'simulator',
        message:
          'Another app or tab is using the camera. Close it and reload, or play with the hand simulator instead.',
      };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        reason: 'overconstrained',
        recovery: 'simulator',
        message:
          'The camera could not provide a usable video mode. You can play with the hand simulator instead.',
      };
    default:
      return {
        reason: 'unknown',
        recovery: 'simulator',
        message: `The camera could not be started${name ? ` (${name})` : ''}. You can play with the hand simulator instead.`,
      };
  }
}

/** The failure used when the page is not a secure context. */
export function insecureContextFailure(): CameraFailure {
  return {
    reason: 'insecure-context',
    recovery: 'simulator',
    message:
      'The camera needs a secure (https) page. You can play with the hand simulator instead.',
  };
}

/** The failure used when the browser has no camera API. */
export function unsupportedFailure(): CameraFailure {
  return {
    reason: 'unsupported',
    recovery: 'simulator',
    message:
      'This browser cannot use the camera. You can play with the hand simulator instead.',
  };
}

/**
 * Extract a thrown value's `name` and `message` without assuming its shape.
 *
 * Object-shaped rejections are the interesting case — `DOMException` carries both
 * fields — and are read directly. Anything else is stringified only when it has a
 * meaningful string form; a bare object would otherwise become the useless
 * `"[object Object]"`, which is worse than admitting there is no detail.
 */
function describeThrown(error: unknown): { name: string; message: string } {
  if (typeof error === 'object' && error !== null) {
    const name = 'name' in error ? String(error.name) : '';
    const message = 'message' in error ? String(error.message) : '';
    return { name, message };
  }
  if (typeof error === 'string') {
    return { name: '', message: error };
  }
  if (
    typeof error === 'number' ||
    typeof error === 'boolean' ||
    typeof error === 'bigint'
  ) {
    return { name: '', message: String(error) };
  }
  if (error === null) {
    return { name: '', message: 'null' };
  }
  return { name: '', message: '' };
}

/** The browser's account of a rejected `play()`, preserved verbatim. */
export function describePlaybackError(
  error: unknown,
  playingAnyway = false,
): PlaybackDiagnostic {
  const { name, message } = describeThrown(error);
  return { name, message, playingAnyway };
}

/** A one-line, copyable rendering of a diagnostic, for the HUD and for reporting. */
export function formatDiagnostic(diagnostic: PlaybackDiagnostic): string {
  if (!diagnostic.name && !diagnostic.message) return 'no error detail was provided';
  return `${diagnostic.name || 'Error'}: ${diagnostic.message || '(no message)'}`;
}

/** Stop every track. Safe on `null` and never throws. */
export function stopStream(stream: MediaStreamLike | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Stopping an already-ended track must not break teardown.
    }
  }
}

/**
 * Release a session: detach the stream, stop every track, remove the element.
 *
 * One cleanup path, used by every failure branch and by teardown. A failure path
 * that forgets the element leaves a composited video in the document; one that
 * forgets the tracks leaves the camera light on.
 */
export function releaseCamera<V extends VideoSurface>(
  environment: CameraEnvironment<V>,
  session: ReleasableSession<V> | null | undefined,
): void {
  if (!session) return;
  session.video.srcObject = null;
  stopStream(session.stream);
  environment.unmountVideo(session.video);
}

/**
 * Guards against overlapping camera starts.
 *
 * Pressing the start button twice, or holding the key down, must not issue two
 * `getUserMedia` calls: the second prompt is confusing and the first stream is
 * then leaked with nothing holding a reference to stop it.
 */
export function createStartGuard(): {
  tryEnter(): boolean;
  exit(): void;
  readonly busy: boolean;
} {
  let busy = false;
  return {
    tryEnter(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    exit(): void {
      busy = false;
    },
    get busy(): boolean {
      return busy;
    },
  };
}

/**
 * The outcome of a promise that is not allowed to hang.
 *
 * A discriminated result rather than a `Promise.race`, because "timed out" and
 * "rejected" need to be distinguishable: they mean different things to the player
 * and different things in the log.
 */
type Attempt<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

function attemptWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<Attempt<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: Attempt<T>): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(outcome);
    };
    const timer = globalThis.setTimeout(() => {
      settle({ kind: 'timeout' });
    }, timeoutMs);

    promise.then(
      (value) => {
        settle({ kind: 'value', value });
      },
      (error: unknown) => {
        settle({ kind: 'error', error });
      },
    );
  });
}

/**
 * Resolve once the element reports intrinsic dimensions.
 *
 * A stream can be granted and still never produce frames (a virtual or
 * misbehaving device), so this is bounded by `CAMERA.metadataTimeoutMs` rather
 * than waiting forever.
 */
function waitForVideoReady(
  video: VideoSurface,
  timeoutMs: number,
): Promise<{ width: number; height: number } | null> {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve({ width: video.videoWidth, height: video.videoHeight });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { width: number; height: number } | null): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('resize', onLoaded);
      resolve(value);
    };
    const onLoaded = (): void => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        finish({ width: video.videoWidth, height: video.videoHeight });
      }
    };
    const timer = globalThis.setTimeout(() => {
      finish(null);
    }, timeoutMs);

    video.addEventListener('loadedmetadata', onLoaded);
    // Some devices report dimensions only after a resize event.
    video.addEventListener('resize', onLoaded);
  });
}

/**
 * Start playback, bounded, and say exactly what happened if it will not start.
 *
 * Three details this gets right that a bare `await video.play()` does not:
 *
 * 1. If the element is already playing — because the `autoplay` attribute won the
 *    race — there is nothing to do, and calling `play()` would be the thing that
 *    *causes* an `AbortError`.
 * 2. If `play()` rejects with `AbortError` while the element is in fact no longer
 *    paused, playback is running and reporting a failure would be wrong. This is
 *    the documented meaning of that rejection when a newer play/load superseded
 *    the request.
 * 3. A `play()` promise that never settles is bounded, so a stuck element cannot
 *    hang camera startup forever.
 */
export async function beginPlayback<V extends VideoSurface>(
  video: V,
  options: { timeoutMs?: number } = {},
): Promise<PlaybackOutcome> {
  const timeoutMs = options.timeoutMs ?? CAMERA.playTimeoutMs;

  if (!video.paused) {
    return { ok: true, diagnostic: null };
  }

  const outcome = await attemptWithin(video.play(), timeoutMs);

  if (outcome.kind === 'timeout') {
    return {
      ok: false,
      failure: {
        reason: 'playback-failed',
        recovery: 'user-gesture',
        diagnostic: {
          // Not a browser error: this is our own bound, and it says so rather
          // than being dressed up as a platform failure.
          name: 'TimeoutError',
          message: `video.play() did not settle within ${timeoutMs} ms`,
          playingAnyway: !video.paused,
        },
        message: `The camera started but video playback did not begin within ${timeoutMs / 1000} seconds. Press Resume video to try again from a click, or play with the hand simulator instead.`,
      },
    };
  }

  if (outcome.kind === 'value') {
    return { ok: true, diagnostic: null };
  }

  {
    const diagnostic = describePlaybackError(outcome.error, !video.paused);

    // See (2) above: a rejection that left the element playing is not a failure.
    if (diagnostic.playingAnyway) {
      return { ok: true, diagnostic };
    }

    const blocked = diagnostic.name === 'NotAllowedError' || diagnostic.name === 'SecurityError';
    const detail = formatDiagnostic(diagnostic);

    return {
      ok: false,
      failure: {
        reason: blocked ? 'playback-blocked' : 'playback-failed',
        // Chrome's autoplay refusals are resolved by a real activation, so both
        // cases get a button rather than only the policy one: a second click is
        // harmless, and a non-policy refusal sometimes clears on retry.
        recovery: 'user-gesture',
        diagnostic,
        message: blocked
          ? `The camera started but the browser blocked video playback (${detail}). Press Resume video to start it from a direct click, or play with the hand simulator instead.`
          : `The camera started but video playback failed (${detail}). Press Resume video to retry, or play with the hand simulator instead.`,
      },
    };
  }
}

/**
 * Get permission, mount the element, attach the stream, and wait briefly for a
 * picture.
 *
 * Deliberately does **not** play. Playback is the step that can fail in a way a
 * user gesture fixes, so it is kept separate and retryable.
 *
 * A missing picture is **not** a failure here. Waiting for `loadedmetadata` before
 * calling `play()` avoids racing playback against the initial load, but some
 * sources only report their dimensions once playback is under way — so a timeout
 * returns a session with `0 × 0` dimensions and lets the caller play and look
 * again. Declaring the camera dead at this point would replace one device failure
 * with another.
 */
export async function acquireCamera<V extends VideoSurface>(
  environment: CameraEnvironment<V>,
  options: { timeoutMs?: number } = {},
): Promise<
  { ok: true; session: CameraSessionParts<V> } | { ok: false; failure: CameraFailure }
> {
  if (!environment.mediaDevices) {
    return {
      ok: false,
      failure: environment.isSecureContext ? unsupportedFailure() : insecureContextFailure(),
    };
  }
  if (!environment.isSecureContext) {
    return { ok: false, failure: insecureContextFailure() };
  }

  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      facingMode: CAMERA.facingMode,
      width: { ideal: CAMERA.idealWidth },
      height: { ideal: CAMERA.idealHeight },
    },
  };

  let stream: MediaStreamLike;
  try {
    stream = await environment.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    return { ok: false, failure: classifyCameraError(error) };
  }

  const video = environment.createVideo();

  // Order matters: mount first, then attach the stream. The element should be in
  // the document before the resource selection algorithm runs.
  environment.mountVideo(video);
  video.srcObject = stream;

  // Wait for a real picture before reporting success. A stream that never
  // produces frames is indistinguishable from a working one until this point.
  const size = await waitForVideoReady(
    video,
    options.timeoutMs ?? CAMERA.metadataTimeoutMs,
  );

  return {
    ok: true,
    session: {
      stream,
      video,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
    },
  };
}

/**
 * Wait for a real picture, after playback has been attempted.
 *
 * Split from {@link acquireCamera} so that the pre-play wait can be optimistic
 * (it fixes a race) without the post-play wait being optional (it catches a stream
 * that genuinely never delivers).
 */
export async function confirmPicture(
  video: VideoSurface,
  options: { timeoutMs?: number } = {},
): Promise<{ width: number; height: number } | null> {
  return waitForVideoReady(video, options.timeoutMs ?? CAMERA.metadataTimeoutMs);
}

/** The failure for a stream that was allowed but produced no frames at all. */
export function streamUnusableFailure(): CameraFailure {
  return {
    reason: 'stream-unusable',
    recovery: 'simulator',
    message:
      'The camera was allowed but never sent a picture. Another app may be holding it. You can play with the hand simulator instead.',
  };
}

/**
 * Start the camera end to end.
 *
 * On a playback failure that a click could fix, the stream is **kept alive** and
 * returned as {@link CameraResult.pending}, so a button handler can finish the job
 * without a second permission prompt. The caller owns that pending object and must
 * either `resume()` it or `release()` it.
 *
 * Any other failure releases everything before returning.
 */
export async function startCamera<V extends VideoSurface>(
  environment: CameraEnvironment<V>,
  options: { timeoutMs?: number; playTimeoutMs?: number } = {},
): Promise<CameraResult<V>> {
  const acquired = await acquireCamera(environment, options);
  if (!acquired.ok) {
    return { ok: false, failure: acquired.failure };
  }

  const { session } = acquired;
  const playback = await beginPlayback(session.video, {
    ...(options.playTimeoutMs === undefined ? {} : { timeoutMs: options.playTimeoutMs }),
  });

  if (playback.ok) {
    // Playback is running, so a picture that had not arrived yet has had its
    // chance. Only now is a silent stream a real failure.
    const size =
      session.width > 0 && session.height > 0
        ? { width: session.width, height: session.height }
        : await confirmPicture(session.video, options);

    if (size === null) {
      releaseCamera(environment, session);
      return { ok: false, failure: streamUnusableFailure() };
    }

    return {
      ok: true,
      ...session,
      width: size.width,
      height: size.height,
      diagnostic: playback.diagnostic,
    };
  }

  // A gesture-recoverable failure keeps the stream; anything else is released.
  if (playback.failure.recovery === 'user-gesture') {
    return {
      ok: false,
      failure: playback.failure,
      pending: createPendingPlayback(environment, session, options),
    };
  }

  releaseCamera(environment, session);
  return { ok: false, failure: playback.failure };
}

/** Build the retryable handle for a stream that is live but not playing. */
function createPendingPlayback<V extends VideoSurface>(
  environment: CameraEnvironment<V>,
  session: CameraSessionParts<V>,
  options: { timeoutMs?: number; playTimeoutMs?: number },
): PendingPlayback<V> {
  let released = false;

  // Defined before the object so `resume` can call it: a method inside an object
  // literal is not a name in scope for its siblings.
  const release = (): void => {
    if (released) return;
    released = true;
    releaseCamera(environment, session);
  };

  return {
    ...session,
    async resume(): Promise<ResumeOutcome> {
      if (released) {
        return {
          ok: false,
          failure: {
            reason: 'stream-unusable',
            recovery: 'simulator',
            message:
              'This camera session was already released. Start the camera again, or play with the hand simulator.',
          },
        };
      }

      const playback = await beginPlayback(session.video, {
        ...(options.playTimeoutMs === undefined ? {} : { timeoutMs: options.playTimeoutMs }),
      });
      if (!playback.ok) return playback;

      // Playback is running, so a picture that was still missing has had its
      // chance. A stream that produces nothing now is genuinely unusable.
      const size = await confirmPicture(session.video, options);
      if (size === null) {
        release();
        return { ok: false, failure: streamUnusableFailure() };
      }

      return {
        ok: true,
        diagnostic: playback.diagnostic,
        width: size.width,
        height: size.height,
      };
    },
    release,
  };
}
