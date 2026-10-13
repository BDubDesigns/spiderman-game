/**
 * The inference frame clock (PLAN.md §6, §7.1).
 *
 * Rendering and inference are separate loops. Rendering is the game loop's rAF
 * (§13 M0). Inference should run once per *new camera frame*, not once per
 * displayed frame: at 60 Hz display and 30 fps video, half of all rAF ticks have
 * no new pixels, and running the detector on them burns frame budget to produce
 * an identical result.
 *
 * `requestVideoFrameCallback` provides exactly that signal. It is not universally
 * available, so this falls back to `requestAnimationFrame`, which the adaptive
 * scheduler can still throttle by measured cost — coarser, but never wrong.
 *
 * The clock reports *frames*. It deliberately does not decide whether a frame
 * deserves an inference: that policy lives in `inferenceScheduler.ts`, so the
 * budget logic has exactly one home.
 */

/** The frame-callback API as this module uses it. */
export interface VideoFrameCallbackSource {
  requestVideoFrameCallback?(
    callback: (nowMs: number, metadata: unknown) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
}

/** The rAF fallback surface. */
export interface AnimationFrameHost {
  requestAnimationFrame(callback: (timeMs: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

export type FrameClockKind = 'video-frame' | 'animation-frame';

export interface FrameClock {
  /** Which API actually drives this clock, surfaced in the debug HUD. */
  readonly kind: FrameClockKind;
  /** Begin delivering frames. Idempotent while already running. */
  start(): void;
  /** Stop delivering frames. Idempotent. */
  stop(): void;
  readonly running: boolean;
}

/**
 * Create a frame clock that calls `onFrame` for each new source frame.
 *
 * `onFrame` must not throw: an exception would break the rescheduling chain.
 * Callers that can fail should catch inside the callback.
 */
export function createFrameClock(
  video: VideoFrameCallbackSource,
  host: AnimationFrameHost,
  onFrame: (nowMs: number) => void,
): FrameClock {
  // Bound up front. Detaching the methods would lose `this`, and rebinding per
  // frame would allocate on every video frame.
  const requestVideo = video.requestVideoFrameCallback?.bind(video);
  const cancelVideo = video.cancelVideoFrameCallback?.bind(video);
  const useVideoFrames = requestVideo !== undefined && cancelVideo !== undefined;

  let running = false;
  let handle: number | null = null;

  const tickVideo = (nowMs: number): void => {
    if (!running) return;
    onFrame(nowMs);
    if (running && requestVideo) handle = requestVideo(tickVideo);
  };

  const tickAnimation = (timeMs: number): void => {
    if (!running) return;
    onFrame(timeMs);
    if (running) handle = host.requestAnimationFrame(tickAnimation);
  };

  return {
    kind: useVideoFrames ? 'video-frame' : 'animation-frame',

    start(): void {
      if (running) return;
      running = true;
      if (useVideoFrames && requestVideo) {
        handle = requestVideo(tickVideo);
      } else {
        handle = host.requestAnimationFrame(tickAnimation);
      }
    },

    stop(): void {
      running = false;
      if (handle === null) return;
      if (useVideoFrames) {
        cancelVideo?.(handle);
      } else {
        host.cancelAnimationFrame(handle);
      }
      handle = null;
    },

    get running(): boolean {
      return running;
    },
  };
}
