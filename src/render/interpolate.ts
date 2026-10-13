/**
 * Rendering between detections (PLAN.md §7.2).
 *
 * **This is a rendering technique, and §7.2 is explicit about what it is not:**
 *
 * - Interpolated positions must **never** be fed to the gesture classifier.
 * - They must **never** be treated as observations by the filter or by identity.
 * - They must **never** be counted as increased inference rate.
 *
 * The HUD reports `interpolated frames drawn since last detection` separately from
 * `inference Hz (measured)`, so the two can never be conflated.
 *
 * The hand is advanced by linear velocity taken from the last two *real*
 * detections — deliberately not by the smoothing filter's state, because that
 * would make rendered positions depend on filter internals and blur the line
 * between "observed" and "drawn". Past `maxInterpolationAgeMs` advancing stops and
 * the frame is marked stale, so a hand that has been lost cannot drift on screen.
 */

import { INTERPOLATION } from '../config';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';

/** One drawn frame's landmark positions and their provenance. */
export interface AdvancedFrame {
  landmarks: NormalizedLandmark[];
  /** Milliseconds since the newest real detection this frame is based on. */
  ageMs: number;
  /** True when these positions were moved from the observation. */
  interpolated: boolean;
  /** True when advancing has stopped because the observation is too old. */
  stale: boolean;
}

interface Observation {
  landmarks: readonly NormalizedLandmark[];
  atMs: number;
}

/**
 * Advances landmarks for drawing only.
 *
 * Fed exclusively by real detections via `observe()`; `advance()` is called once
 * per rendered frame.
 */
export class LandmarkInterpolator {
  private previous: Observation | null = null;
  private latest: Observation | null = null;
  private interpolatedFrameCount = 0;

  constructor(private readonly maxAgeMs: number = INTERPOLATION.maxInterpolationAgeMs) {}

  /** How many frames have been drawn with advanced positions. */
  get interpolatedFrames(): number {
    return this.interpolatedFrameCount;
  }

  /** Record a real detection. The only way data enters this class. */
  observe(landmarks: readonly NormalizedLandmark[], atMs: number): void {
    if (this.latest !== null) this.previous = this.latest;
    this.latest = { landmarks, atMs };
  }

  /** Forget everything — used when the source changes or a hand is lost. */
  reset(): void {
    this.previous = null;
    this.latest = null;
    this.interpolatedFrameCount = 0;
  }

  /**
   * Landmarks to draw at `nowMs`, or `null` when nothing has been observed.
   *
   * With no second observation, or with the observation already old, this returns
   * the newest real positions unchanged rather than inventing motion.
   */
  advance(nowMs: number): AdvancedFrame | null {
    const latest = this.latest;
    if (latest === null) return null;

    const ageMs = Math.max(0, nowMs - latest.atMs);
    const unreachable = !INTERPOLATION.enabled || ageMs <= 0 || ageMs > this.maxAgeMs;

    if (unreachable) {
      return {
        landmarks: latest.landmarks.map((point) => ({ ...point })),
        ageMs,
        interpolated: false,
        stale: ageMs > this.maxAgeMs,
      };
    }

    const previous = this.previous;
    // No velocity to use yet: draw the observation as-is rather than guess.
    if (previous === null || previous.atMs >= latest.atMs) {
      return {
        landmarks: latest.landmarks.map((point) => ({ ...point })),
        ageMs,
        interpolated: false,
        stale: false,
      };
    }

    const deltaMs = latest.atMs - previous.atMs;
    const elapsedMs = nowMs - latest.atMs;
    const count = Math.min(previous.landmarks.length, latest.landmarks.length);

    const landmarks: NormalizedLandmark[] = latest.landmarks.map((point, index) => {
      const from = previous.landmarks[index];
      // A landmark present in only one of the two frames has no velocity; hold it.
      if (index >= count || from === undefined) return { ...point };

      const advancedX = point.x + ((point.x - from.x) / deltaMs) * elapsedMs;
      const advancedY = point.y + ((point.y - from.y) / deltaMs) * elapsedMs;
      const advanced: NormalizedLandmark = { x: advancedX, y: advancedY };

      // `z` is passed through, never extrapolated: §8 Rule C keeps it out of
      // anything that could be mistaken for a measurement, and inventing one here
      // would be exactly that.
      if (point.z !== undefined) advanced.z = point.z;
      return advanced;
    });

    this.interpolatedFrameCount += 1;
    return { landmarks, ageMs, interpolated: true, stale: false };
  }
}
