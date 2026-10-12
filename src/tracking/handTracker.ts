/**
 * MediaPipe HandLandmarker wrapper (PLAN.md §5, §7, §8).
 *
 * Two layers live here:
 *
 * 1. {@link HandTracker} — the thin adapter over `HandLandmarker`. It owns
 *    initialization (including the GPU → CPU delegate fallback), the
 *    handedness-label fix from §8, and the detection call.
 * 2. {@link CameraHandSource} — a `HandFrameSource`, so the camera path is
 *    interchangeable with `MouseSource` and `ReplaySource` and the same game code
 *    consumes all three. This is the seam that keeps the M0 harness meaningful.
 *
 * ---- Verified against the installed 1.1.0 `vision.d.ts` ----
 *
 * - `detectForVideo(videoFrame, timestamp)` is **synchronous**. On the main thread
 *   it blocks rendering for the whole call, which is exactly the premise of the
 *   worker decision gate in §7.3. There is no `detectAsync` on the Web build.
 * - The result has `landmarks`, `worldLandmarks`, `handedness` and the deprecated
 *   `handednesses`. We consume `landmarks` and `handedness` and nothing else.
 * - There is **no per-hand detection, presence or tracking confidence** in the
 *   result. `handedness[i][0].score` is the left/right *classification* score, not
 *   a hand-presence confidence, and must never be presented as one (§5.1, §6.2).
 *
 * ---- Testability ----
 *
 * The model is reached only through the injected {@link LandmarkerFactory}, and
 * the detection result is described by the structural {@link DetectedHandLike}
 * rather than the library's class, so mapping, the delegate fallback and the
 * stale-frame policy are all unit-tested without WASM or a camera.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

import { INFERENCE, MEDIAPIPE } from '../config';
import {
  LANDMARK_COUNT,
  type FrameProvenance,
  type HandFrameSource,
  type Handedness,
  type HandednessLabel,
  type NormalizedLandmark,
  type RawFrame,
  type RawHandFrame,
} from './landmarkTypes';

/** The delegate MediaPipe runs on. */
export type LandmarkerDelegate = 'GPU' | 'CPU';

/** Options handed to `HandLandmarker.createFromOptions`. */
export interface HandLandmarkerConfig {
  wasmBasePath: string;
  modelAssetPath: string;
  numHands: number;
  /**
   * Detection/presence/tracking thresholds are model INPUTS. They are never
   * echoed back in the result and must not be reported as observations (§5.1).
   */
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
}

/** The parts of a MediaPipe handedness `Category` we consume. */
export interface DetectedCategoryLike {
  categoryName: string;
  score: number;
}

/** The parts of a MediaPipe `NormalizedLandmark` we consume. */
export interface DetectedLandmarkLike {
  x: number;
  y: number;
  z?: number;
}

/**
 * The parts of `HandLandmarkerResult` we consume.
 *
 * Structural on purpose: the real `HandLandmarkerResult` satisfies it (its
 * landmarks carry extra `visibility`/`presence` fields we deliberately drop, and
 * its categories carry `index`/`displayName`), and tests can build one as a plain
 * object literal.
 */
export interface DetectedHandLike {
  landmarks: DetectedLandmarkLike[][];
  handedness: DetectedCategoryLike[][];
}

/** The parts of `HandLandmarker` this project uses. */
export interface HandLandmarkerLike {
  /** Synchronous. See the file header. */
  detectForVideo(video: HTMLVideoElement, timestampMs: number): DetectedHandLike;
  close(): void;
}

export type LandmarkerFactory = (
  delegate: LandmarkerDelegate,
  config: HandLandmarkerConfig,
) => Promise<HandLandmarkerLike>;

/**
 * The real factory. The only place in the codebase that touches MediaPipe's
 * runtime API, so it is the only place that can break when the library churns.
 */
export const mediapipeLandmarkerFactory: LandmarkerFactory = async (
  delegate,
  config,
) => {
  const fileset = await FilesetResolver.forVisionTasks(config.wasmBasePath);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    // `delegate` must be nested here. A top-level `delegate` is a type error in
    // 1.1.0, and it is a common mistake.
    baseOptions: {
      modelAssetPath: config.modelAssetPath,
      delegate,
    },
    // The Web build accepts only "IMAGE" | "VIDEO" — no LIVE_STREAM, and the
    // `RunningMode` type is not exported, so the literal is inlined.
    runningMode: 'VIDEO',
    numHands: config.numHands,
    minHandDetectionConfidence: config.minHandDetectionConfidence,
    minHandPresenceConfidence: config.minHandPresenceConfidence,
    minTrackingConfidence: config.minTrackingConfidence,
  });

  return {
    detectForVideo: (video, timestampMs) =>
      landmarker.detectForVideo(video, timestampMs),
    close: () => {
      landmarker.close();
    },
  };
};

/**
 * Map the model's handedness category to our label.
 *
 * PLAN.md §8: the label is defined against a specific mirroring assumption and a
 * mirrored pipeline can invert it, so it must be verified on a real device before
 * being trusted. `swap` is that single global correction, and this function is the
 * only place it is applied.
 */
export function toHandednessLabel(categoryName: string, swap: boolean): HandednessLabel {
  const label: HandednessLabel = categoryName === 'Left' ? 'Left' : 'Right';
  if (!swap) return label;
  return label === 'Left' ? 'Right' : 'Left';
}

/**
 * Map a whole detection result to our own types.
 *
 * Pure, and deliberately lossy: `worldLandmarks` (§8 Rule C — not used in v1) and
 * per-landmark `visibility`/`presence` are dropped rather than carried along, so
 * nothing downstream can quietly start depending on them. `z` is passed through
 * because it is part of the raw landmark, with the same Rule C prohibition.
 */
export function mapDetectedHands(
  result: DetectedHandLike,
  swapHandedness: boolean,
): RawHandFrame[] {
  const hands: RawHandFrame[] = [];

  for (let i = 0; i < result.landmarks.length; i += 1) {
    const rawLandmarks = result.landmarks[i];
    if (!rawLandmarks) continue;

    const landmarks: NormalizedLandmark[] = rawLandmarks.map((lm) =>
      lm.z === undefined ? { x: lm.x, y: lm.y } : { x: lm.x, y: lm.y, z: lm.z },
    );

    // One classification per hand, wrapped in a single-element array by the
    // model. Absent categories fall back to a neutral label rather than a crash.
    const rawHandedness = result.handedness[i]?.[0];
    const handedness: Handedness = {
      label: toHandednessLabel(rawHandedness?.categoryName ?? '', swapHandedness),
      score: rawHandedness?.score ?? 0,
    };

    hands.push({ landmarks, handedness });
  }

  return hands;
}

/** Observable state of the tracker. Read by the debug HUD; never fabricated. */
export interface HandTrackerStats {
  ready: boolean;
  /** The delegate that actually initialized. */
  delegate: LandmarkerDelegate | null;
  /** True when the preferred delegate failed and CPU was used instead (§7.3). */
  delegateFallback: boolean;
  /** Why the fallback happened, for the HUD. `null` when there was none. */
  delegateMessage: string | null;
  detectCalls: number;
  detectFailures: number;
  lastDetectMs: number;
  /** Hands returned by the most recent successful detection. */
  lastHandCount: number;
  /** Hands seen carrying an unexpected landmark count, summed over the session. */
  incompleteHands: number;
}

export interface HandTrackerOptions extends HandLandmarkerConfig {
  preferredDelegate: LandmarkerDelegate;
  /** PLAN.md §8 handedness correction. Defaults to `MEDIAPIPE.swapHandedness`. */
  swapHandedness?: boolean;
  /** Injected for tests. Defaults to the real MediaPipe factory. */
  factory?: LandmarkerFactory;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Adapter over the MediaPipe hand landmarker.
 *
 * Initialization never throws on delegate failure: a GPU delegate that cannot
 * start is an expected condition, and §7.3 requires falling back to CPU rather
 * than failing.
 */
export class HandTracker {
  readonly stats: HandTrackerStats = {
    ready: false,
    delegate: null,
    delegateFallback: false,
    delegateMessage: null,
    detectCalls: 0,
    detectFailures: 0,
    lastDetectMs: 0,
    lastHandCount: 0,
    incompleteHands: 0,
  };

  private readonly config: HandLandmarkerConfig;
  private readonly preferredDelegate: LandmarkerDelegate;
  private readonly swapHandedness: boolean;
  private readonly factory: LandmarkerFactory;
  private landmarker: HandLandmarkerLike | null = null;

  constructor(options: HandTrackerOptions) {
    this.config = {
      wasmBasePath: options.wasmBasePath,
      modelAssetPath: options.modelAssetPath,
      numHands: options.numHands,
      minHandDetectionConfidence: options.minHandDetectionConfidence,
      minHandPresenceConfidence: options.minHandPresenceConfidence,
      minTrackingConfidence: options.minTrackingConfidence,
    };
    this.preferredDelegate = options.preferredDelegate;
    this.swapHandedness = options.swapHandedness ?? MEDIAPIPE.swapHandedness;
    this.factory = options.factory ?? mediapipeLandmarkerFactory;
  }

  /**
   * Initialize, trying the preferred delegate first.
   *
   * Resolves with the stats on success. Rejects only when *every* candidate
   * delegate failed, which means the model or WASM could not be loaded at all —
   * a condition the caller turns into the simulator fallback.
   */
  async init(): Promise<HandTrackerStats> {
    const candidates: LandmarkerDelegate[] =
      this.preferredDelegate === 'GPU' ? ['GPU', 'CPU'] : ['CPU'];

    let lastError: unknown = null;

    for (const delegate of candidates) {
      try {
        this.landmarker = await this.factory(delegate, this.config);
        this.stats.delegate = delegate;
        this.stats.delegateFallback = delegate !== this.preferredDelegate;
        this.stats.delegateMessage = this.stats.delegateFallback
          ? `${this.preferredDelegate} delegate unavailable (${describeError(lastError)}); using ${delegate}`
          : null;
        this.stats.ready = true;
        return this.stats;
      } catch (error) {
        lastError = error;
      }
    }

    this.stats.delegateMessage = `no usable delegate: ${describeError(lastError)}`;
    throw new Error(
      `HandTracker failed to initialize on any delegate (${candidates.join(', ')}): ${describeError(lastError)}`,
    );
  }

  get ready(): boolean {
    return this.stats.ready && this.landmarker !== null;
  }

  /** Which delegate is live. `null` before a successful init. */
  get delegate(): LandmarkerDelegate | null {
    return this.stats.delegate;
  }

  /**
   * Run one detection.
   *
   * Throws only when the tracker is not ready or the model itself threw, so the
   * caller can count consecutive failures and degrade deliberately (§7.3).
   */
  detect(video: HTMLVideoElement, timestampMs: number): RawHandFrame[] {
    const landmarker = this.landmarker;
    if (!landmarker) {
      throw new Error('HandTracker.detect called before a successful init()');
    }

    const startedAt = globalThis.performance.now();
    this.stats.detectCalls += 1;
    try {
      const result = landmarker.detectForVideo(video, timestampMs);
      const hands = mapDetectedHands(result, this.swapHandedness);
      for (const hand of hands) {
        if (hand.landmarks.length !== LANDMARK_COUNT) {
          this.stats.incompleteHands += 1;
        }
      }
      this.stats.lastHandCount = hands.length;
      this.stats.lastDetectMs = globalThis.performance.now() - startedAt;
      return hands;
    } catch (error) {
      this.stats.detectFailures += 1;
      this.stats.lastDetectMs = globalThis.performance.now() - startedAt;
      throw error;
    }
  }

  /** Release the model. Safe to call more than once. */
  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.stats.ready = false;
  }
}

/**
 * Outcome of one attempted detection, for the caller's failure policy.
 *
 * The successful case returns the observations so the caller can run identity
 * association exactly once per *detection*. Doing it per rendered frame instead
 * would re-observe the same hands many times over and defeat the staleness and
 * grace logic in §10 completely.
 */
export type DetectionOutcome =
  | { ok: true; handCount: number; hands: RawHandFrame[] }
  | { ok: false; message: string; disabled: boolean };

/**
 * A `HandFrameSource` backed by the camera.
 *
 * `frameAt()` serves the most recent observation. PLAN.md §7.2 allows advancing
 * landmarks between detections for rendering only; this does **not** do that. It
 * reports the age of the last observation instead, so the HUD can show a stale
 * hand rather than a hand that pretends to be current. Interpolation belongs with
 * smoothing in M2, where it can be tested against real recordings.
 */
export class CameraHandSource implements HandFrameSource {
  readonly id = 'camera';
  readonly provenance: FrameProvenance = 'observed';

  private latest: RawFrame | null = null;
  private lastDetectionMs = 0;
  private started = false;
  private startedAtMs = 0;
  private framesSinceDetection = 0;
  private failureStreak = 0;
  private disabled = false;

  constructor(private readonly tracker: HandTracker) {}

  start(nowMs: number): void {
    this.started = true;
    this.startedAtMs = nowMs;
    this.lastDetectionMs = nowMs;
    this.latest = null;
    this.framesSinceDetection = 0;
  }

  stop(): void {
    this.started = false;
  }

  /** True once failures have exceeded the configured budget. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  get consecutiveFailures(): number {
    return this.failureStreak;
  }

  /** Renders that have happened since the last successful detection (§7.2). */
  get framesDrawnSinceDetection(): number {
    return this.framesSinceDetection;
  }

  /** Milliseconds since the last successful detection. */
  msSinceDetection(nowMs: number): number {
    if (this.latest === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, nowMs - this.lastDetectionMs);
  }

  /**
   * §7.2: past `INFERENCE.maxStalenessMs` the last observation stops being
   * presented as current, so the HUD can mark it rather than let a lost hand
   * appear to hold position.
   */
  isStale(nowMs: number): boolean {
    return this.latest === null || this.msSinceDetection(nowMs) > INFERENCE.maxStalenessMs;
  }

  get handednessCounts(): { left: number; right: number } {
    const hands = this.latest?.hands ?? [];
    let left = 0;
    let right = 0;
    for (const hand of hands) {
      if (hand.handedness.label === 'Left') left += 1;
      else right += 1;
    }
    return { left, right };
  }

  /** Session duration, for the reliability figures in §7.3. */
  sessionMs(nowMs: number): number {
    return Math.max(0, nowMs - this.startedAtMs);
  }

  /**
   * Run one detection and store the result.
   *
   * The caller decides *when* to call this — that is the scheduler's job — so
   * this method contains no timing policy of its own.
   */
  detectNow(video: HTMLVideoElement, nowMs: number): DetectionOutcome {
    if (!this.started || this.disabled) {
      return { ok: false, message: 'not running', disabled: this.disabled };
    }

    let hands: RawHandFrame[];
    try {
      hands = this.tracker.detect(video, nowMs);
    } catch (error) {
      this.failureStreak += 1;
      const exhausted = this.failureStreak >= INFERENCE.maxConsecutiveFailures;
      if (exhausted) this.disabled = true;
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        disabled: exhausted,
      };
    }

    this.failureStreak = 0;
    this.lastDetectionMs = nowMs;
    this.framesSinceDetection = 0;
    this.latest = {
      // Always the render clock, so `timestampMs` stays monotonic across sources.
      timestampMs: nowMs,
      hands,
      sourceId: this.id,
      provenance: this.provenance,
    };
    return { ok: true, handCount: hands.length, hands };
  }

  frameAt(_nowMs: number): RawFrame | null {
    if (!this.started) return null;
    if (this.latest !== null) {
      this.framesSinceDetection += 1;
    }
    return this.latest;
  }
}
