/**
 * The seam between "how hands are detected" and everything downstream of it.
 *
 * PLAN.md §7.3 makes the worker a *decision*, not a default, so the two
 * configurations have to be swappable without touching the renderer, the identity
 * tracker or the game loop. That is what this interface is for, and it is deliberately
 * narrower than either implementation.
 *
 * Both implementations report two different timings, and the distinction is the whole
 * point of the A/B:
 *
 * - `costMs` — the backend's **own processing time**. Comparable across modes, because
 *   it is the same `detectForVideo` call either way.
 * - the caller's measured wall time — the **round trip**. For the main thread that
 *   equals `costMs`, since the call blocks. For a worker it is larger by the capture
 *   and the two transfers, and that difference is exactly what the worker costs.
 *
 * The scheduler budgets on the round trip (it is the delay the app must live with),
 * while the export reports both so the overhead is visible rather than inferred.
 */

import type {
  HandLandmarkerConfig,
  HandTracker,
  LandmarkerDelegate,
} from './handTracker';
import type { RawHandFrame } from './landmarkTypes';

/** One observation, with the backend's own processing time attached. */
export interface DetectedHands {
  hands: RawHandFrame[];
  /** The backend's own processing time in ms, not the round trip. */
  costMs: number;
}

export interface DetectionBackend {
  readonly kind: 'main-thread' | 'worker';
  /** Which delegate is live, or `null` before a successful init. */
  readonly delegate: LandmarkerDelegate | null;
  /** True when the preferred delegate failed and another was used. */
  readonly delegateFallback: boolean;
  /** Why the fallback happened, for the HUD. `null` when there was none. */
  readonly delegateMessage: string | null;
  /** Acquire whatever the backend needs. Rejects if nothing usable initialises. */
  init(): Promise<void>;
  /** Observe one frame. The promise resolves with the result, or rejects. */
  detect(video: HTMLVideoElement, timestampMs: number): Promise<DetectedHands>;
  /** Release everything. Safe to call more than once. */
  close(): void;
}

/**
 * The baseline: MediaPipe on the main thread.
 *
 * Deliberately thin. All of the actual behaviour — the synchronous call, the call
 * counter and the measured duration — already lives in `HandTracker`, which is
 * separately tested, so this only adapts it to the backend shape.
 */
export class MainThreadDetectionBackend implements DetectionBackend {
  readonly kind = 'main-thread' as const;

  constructor(private readonly tracker: HandTracker) {}

  get delegate(): LandmarkerDelegate | null {
    return this.tracker.delegate;
  }

  get delegateFallback(): boolean {
    return this.tracker.stats.delegateFallback;
  }

  get delegateMessage(): string | null {
    return this.tracker.stats.delegateMessage;
  }

  async init(): Promise<void> {
    await this.tracker.init();
  }

  detect(video: HTMLVideoElement, timestampMs: number): Promise<DetectedHands> {
    // The synchronous call blocks here, exactly as it always has. `lastDetectMs` is
    // measured inside `HandTracker.detect`, so it is the true blocking duration.
    const hands = this.tracker.detect(video, timestampMs);
    return Promise.resolve({ hands, costMs: this.tracker.stats.lastDetectMs });
  }

  close(): void {
    this.tracker.close();
  }
}

/** What the worker needs in order to initialise, over the wire. */
export interface WorkerInitRequest {
  config: HandLandmarkerConfig;
  preferredDelegate: LandmarkerDelegate;
  swapHandedness: boolean;
}
