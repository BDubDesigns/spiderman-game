/**
 * The game loop: a fixed-timestep update decoupled from rendering.
 *
 * PLAN.md §13 M0 item 7 and §7.1 require this separation early, before there is
 * anything to simulate. The reason is that simulation correctness and render
 * smoothness have different requirements: the update must advance in fixed
 * increments so physics/scoring are frame-rate independent and reproducible in
 * tests, while rendering must happen once per displayed frame and may be
 * interpolated by `alpha`.
 *
 * M0 has no game systems (PLAN.md §13 M0: targets, webs and scoring are M3/M4),
 * so `update` currently does bookkeeping only. The loop exists now so that M3
 * does not have to retrofit a timebase into code that assumed one-update-per-
 * frame.
 *
 * The scheduler is injectable, so the whole loop is unit-testable without a
 * browser and without waiting in real time.
 */

import { LOOP } from '../config';
import { clamp } from '../render/stage';

/** Minimal scheduling surface, structurally satisfied by `requestAnimationFrame`. */
export interface Scheduler {
  /** Schedule `callback` for the next display frame; returns a cancellable handle. */
  request(callback: (timeMs: number) => void): number;
  /** Cancel a handle returned by {@link Scheduler.request}. */
  cancel(handle: number): void;
  /** A monotonic clock in ms, on the same timebase passed to the callback. */
  now(): number;
}

/** The browser scheduler. `requestAnimationFrame` passes `performance.now()`-based
 *  timestamps, so the two timebases line up without conversion. */
export const rafScheduler: Scheduler = {
  request: (callback) =>
    globalThis.requestAnimationFrame((timeMs) => {
      callback(timeMs);
    }),
  cancel: (handle) => {
    globalThis.cancelAnimationFrame(handle);
  },
  now: () => globalThis.performance.now(),
};

/** Live loop diagnostics, surfaced in the debug HUD. */
export interface LoopStats {
  /** Rendered frames since construction. */
  renderedFrames: number;
  /** Fixed update steps since construction. */
  updateSteps: number;
  /** Measured wall time of the most recent rendered frame, in ms (unclamped). */
  lastFrameMs: number;
  /** Smoothed render rate over the last `fpsWindowFrames` frames. */
  fps: number;
  /** Time discarded by the stall clamp or the catch-up cap, in ms. */
  droppedMs: number;
}

export interface FixedStepLoopOptions {
  /** Simulation timestep, in ms. */
  fixedDtMs: number;
  /** Clamp for a single frame's measured elapsed time. */
  maxFrameMs: number;
  /** Cap on update steps per rendered frame. */
  maxUpdatesPerFrame: number;
  /** Number of render timestamps to average FPS over. */
  fpsWindowFrames?: number;
  /** Advance the simulation. `dtMs` is always exactly `fixedDtMs`. */
  update(dtMs: number, nowMs: number, stepIndex: number): void;
  /** Draw. `alpha` is the fraction of a step elapsed since the last update. */
  render(alpha: number, nowMs: number): void;
  /** Defaults to {@link rafScheduler}. */
  scheduler?: Scheduler;
}

export interface FixedStepLoop {
  /** Begin scheduling frames. Idempotent while already running. */
  start(): void;
  /** Stop scheduling frames. Idempotent. */
  stop(): void;
  readonly running: boolean;
  /** Live diagnostics object. Read-only by convention; not a copy. */
  readonly stats: Readonly<LoopStats>;
}

/**
 * Create the loop.
 *
 * Timing policy:
 * - A frame whose measured elapsed time exceeds `maxFrameMs` (tab was
 *   backgrounded, GC pause, devtools open) is clamped, and the excess is counted
 *   in `stats.droppedMs`. Without this, returning to the tab would run hundreds
 *   of catch-up updates in one frame — the classic spiral of death.
 * - At most `maxUpdatesPerFrame` steps run per frame. If the backlog still
 *   exceeds one step after that, it is dropped rather than carried, which keeps
 *   the sim from falling ever further behind. Dropped time is reported, never
 *   silently hidden.
 * - `update` therefore always receives exactly `fixedDtMs`, and is never called
 *   with a variable delta.
 */
export function createFixedStepLoop(options: FixedStepLoopOptions): FixedStepLoop {
  const {
    fixedDtMs,
    maxFrameMs,
    maxUpdatesPerFrame,
    update,
    render,
    scheduler = rafScheduler,
  } = options;
  const fpsWindowFrames = options.fpsWindowFrames ?? LOOP.fpsWindowFrames;

  if (!(fixedDtMs > 0)) {
    throw new RangeError(`fixedDtMs must be positive, got ${fixedDtMs}`);
  }
  if (!(maxFrameMs > 0)) {
    throw new RangeError(`maxFrameMs must be positive, got ${maxFrameMs}`);
  }
  if (!Number.isInteger(maxUpdatesPerFrame) || maxUpdatesPerFrame < 1) {
    throw new RangeError(
      `maxUpdatesPerFrame must be a positive integer, got ${maxUpdatesPerFrame}`,
    );
  }

  const stats: LoopStats = {
    renderedFrames: 0,
    updateSteps: 0,
    lastFrameMs: 0,
    fps: 0,
    droppedMs: 0,
  };

  /** Render timestamps, capped at `fpsWindowFrames`, for the FPS average. */
  const stamps: number[] = [];
  let running = false;
  let handle: number | null = null;
  let previousMs = 0;
  let accumulatorMs = 0;
  let stepIndex = 0;

  function recordFps(nowMs: number): void {
    stamps.push(nowMs);
    if (stamps.length > fpsWindowFrames) {
      stamps.shift();
    }
    const first = stamps[0];
    const last = stamps[stamps.length - 1];
    if (first === undefined || last === undefined || stamps.length < 2) {
      stats.fps = 0;
      return;
    }
    const span = last - first;
    stats.fps = span > 0 ? ((stamps.length - 1) * 1000) / span : 0;
  }

  function frame(timeMs: number): void {
    if (!running) return;

    const nowMs = Number.isFinite(timeMs) ? timeMs : scheduler.now();
    const rawElapsedMs = nowMs - previousMs;
    previousMs = nowMs;

    const elapsedMs = clamp(rawElapsedMs, 0, maxFrameMs);
    if (rawElapsedMs > maxFrameMs) {
      stats.droppedMs += rawElapsedMs - maxFrameMs;
    }
    accumulatorMs += elapsedMs;

    let steps = 0;
    while (accumulatorMs >= fixedDtMs && steps < maxUpdatesPerFrame) {
      update(fixedDtMs, nowMs, stepIndex);
      stepIndex += 1;
      steps += 1;
      stats.updateSteps += 1;
      accumulatorMs -= fixedDtMs;
    }

    if (steps === maxUpdatesPerFrame && accumulatorMs >= fixedDtMs) {
      stats.droppedMs += accumulatorMs;
      accumulatorMs = 0;
    }

    stats.lastFrameMs = rawElapsedMs;
    render(accumulatorMs / fixedDtMs, nowMs);
    stats.renderedFrames += 1;
    recordFps(nowMs);

    if (running) {
      handle = scheduler.request(frame);
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      previousMs = scheduler.now();
      accumulatorMs = 0;
      stamps.length = 0;
      stats.fps = 0;
      handle = scheduler.request(frame);
    },
    stop(): void {
      running = false;
      if (handle !== null) {
        scheduler.cancel(handle);
        handle = null;
      }
    },
    get running(): boolean {
      return running;
    },
    stats,
  };
}
