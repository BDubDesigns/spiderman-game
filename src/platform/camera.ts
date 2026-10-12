/**
 * Camera capture: `getUserMedia`, the video element, and permission failures.
 *
 * PLAN.md §13 M1 requires camera denial to be handled here, and §15 risk 13
 * requires it not be deferred: a denied camera must offer the M0 simulator as a
 * playable option, never a dead end.
 *
 * ---- Testability ----
 *
 * Nothing in this module reaches for a global. The platform surface it needs is
 * injected as a {@link CameraEnvironment}, and the video element is whatever the
 * environment's factory returns, so the whole module is unit-testable with no
 * DOM and no camera. `browserCameraEnvironment()` is the one function that
 * touches real globals.
 *
 * ---- Why a failure taxonomy rather than an error ----
 *
 * "The camera did not work" is not actionable. Each reason below has a different
 * cause and a different thing the player can do about it, and each one still
 * leads to the simulator.
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
  readonly videoWidth: number;
  readonly videoHeight: number;
  play(): Promise<void>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * The parts of `MediaDevices` this module uses.
 *
 * The return type is `MediaStreamLike` rather than `MediaStream` so the real
 * `MediaDevices` still satisfies this (a `MediaStream` is a `MediaStreamLike`),
 * while tests can supply a fake stream with no cast.
 */
export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
}

/** Everything this module needs from the platform. */
export interface CameraEnvironment<V extends VideoSurface = VideoSurface> {
  mediaDevices: MediaDevicesLike | undefined;
  isSecureContext: boolean;
  /** Create the (detached) element the stream will be attached to. */
  createVideo(): V;
}

/** Real browser environment. The only place globals are read. */
export function browserCameraEnvironment(): CameraEnvironment<HTMLVideoElement> {
  return {
    // Browser-only entry point, so `navigator` is assumed present; the injected
    // environment is what makes the rest of this module testable without it.
    mediaDevices: globalThis.navigator.mediaDevices,
    isSecureContext: globalThis.isSecureContext === true,
    createVideo: () => {
      const video = document.createElement('video');
      // `playsinline` + `muted` are what make autoplay legal on iOS Safari
      // (PLAN.md §15 risk 12).
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      return video;
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
  | 'unknown';

export interface CameraFailure {
  reason: CameraFailureReason;
  /** Player-facing, non-technical, and always leads somewhere. */
  message: string;
}

export type CameraResult<V extends VideoSurface = VideoSurface> =
  | {
      ok: true;
      stream: MediaStreamLike;
      video: V;
      /** Intrinsic dimensions, synced to the canvas per PLAN.md §8 Rule A. */
      width: number;
      height: number;
    }
  | { ok: false; failure: CameraFailure };

/**
 * Map a thrown value to a failure. Pure, so the whole taxonomy is unit-tested.
 *
 * The DOM exception names are checked by name rather than by `instanceof`,
 * because `DOMException` is not reliable across realms and some browsers throw
 * plain objects with a legacy `name` (e.g. `TrackStartError`).
 */
export function classifyCameraError(error: unknown): CameraFailure {
  // `'name' in error` narrows to an object with an unknown `name`, so no cast is
  // needed — and an unnecessary one here would hide a change in that narrowing.
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String(error.name)
      : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        reason: 'denied',
        message:
          'Camera access is blocked. You can allow it in your browser settings and reload, or play with the hand simulator instead.',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        reason: 'not-found',
        message:
          'No camera was found on this device. You can play with the hand simulator instead.',
      };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        reason: 'in-use',
        message:
          'Another app or tab is using the camera. Close it and reload, or play with the hand simulator instead.',
      };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        reason: 'overconstrained',
        message:
          'The camera could not provide a usable video mode. You can play with the hand simulator instead.',
      };
    default:
      return {
        reason: 'unknown',
        message:
          'The camera could not be started. You can play with the hand simulator instead.',
      };
  }
}

/** The failure used when the page is not a secure context. */
export function insecureContextFailure(): CameraFailure {
  return {
    reason: 'insecure-context',
    message:
      'The camera needs a secure (https) page. You can play with the hand simulator instead.',
  };
}

/** The failure used when the browser has no camera API. */
export function unsupportedFailure(): CameraFailure {
  return {
    reason: 'unsupported',
    message:
      'This browser cannot use the camera. You can play with the hand simulator instead.',
  };
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
 * Start the camera and attach it to a fresh video element.
 *
 * Returns a discriminated result rather than throwing: a denied camera is an
 * expected state in this game, not an exceptional one.
 */
export async function startCamera<V extends VideoSurface>(
  environment: CameraEnvironment<V>,
  options: { timeoutMs?: number } = {},
): Promise<CameraResult<V>> {
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
  video.srcObject = stream;

  // Autoplay can reject even when muted, in which case the app still needs to
  // know rather than silently drawing a frozen frame.
  try {
    await video.play();
  } catch {
    stopStream(stream);
    return {
      ok: false,
      failure: {
        reason: 'unknown',
        message:
          'The camera started but would not play. You can play with the hand simulator instead.',
      },
    };
  }

  const size = await waitForVideoReady(video, options.timeoutMs ?? CAMERA.metadataTimeoutMs);
  if (size === null) {
    stopStream(stream);
    return {
      ok: false,
      failure: {
        reason: 'unknown',
        message:
          'The camera started but never sent a picture. You can play with the hand simulator instead.',
      },
    };
  }

  return { ok: true, stream, video, width: size.width, height: size.height };
}
