/**
 * Per-identity drawing pipeline (PLAN.md §7.2).
 *
 * Deliberately separate from `GestureController`: §11.6 smooths in two copies for
 * classification versus display, and §7.2 allows advancing those display
 * positions between detections. Keeping the advancing here means there is exactly
 * one place where a position can differ from an observation, and it is a place the
 * gesture pipeline cannot reach.
 *
 * The gesture classifier is fed from `GestureController`'s classify stream, never
 * from this class. Nothing here is ever reported as an observation or as inference
 * rate.
 */

import type { HandIdentityId } from '../tracking/handIdentity';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';
import { LandmarkInterpolator } from './interpolate';

/** One hand ready to draw. */
export interface DrawableHand {
  identity: HandIdentityId;
  landmarks: NormalizedLandmark[];
  /** True when these positions were advanced beyond the last observation. */
  interpolated: boolean;
  /** True when advancing stopped because the observation is too old. */
  stale: boolean;
  ageMs: number;
}

export class HandRenderPipeline {
  private readonly interpolators = new Map<HandIdentityId, LandmarkInterpolator>();

  /** Total frames drawn with advanced positions, for the HUD. */
  get interpolatedFrames(): number {
    let total = 0;
    for (const interpolator of this.interpolators.values()) {
      total += interpolator.interpolatedFrames;
    }
    return total;
  }

  reset(): void {
    this.interpolators.clear();
  }

  /**
   * Record a fresh observation for an identity.
   *
   * Stale hands are not observed: their positions are the tracker's held copy, and
   * feeding those back would let the interpolator treat a frozen position as
   * movement.
   */
  observe(identity: HandIdentityId, landmarks: readonly NormalizedLandmark[], atMs: number): void {
    let interpolator = this.interpolators.get(identity);
    if (interpolator === undefined) {
      interpolator = new LandmarkInterpolator();
      this.interpolators.set(identity, interpolator);
    }
    interpolator.observe(landmarks, atMs);
  }

  /** Forget an identity's history, e.g. when it is lost. */
  forget(identity: HandIdentityId): void {
    this.interpolators.delete(identity);
  }

  /** Positions to draw at `nowMs`, in the order last observed. */
  advance(nowMs: number): DrawableHand[] {
    const drawable: DrawableHand[] = [];
    for (const [identity, interpolator] of this.interpolators) {
      const frame = interpolator.advance(nowMs);
      if (frame === null) continue;
      drawable.push({
        identity,
        landmarks: frame.landmarks,
        interpolated: frame.interpolated,
        stale: frame.stale,
        ageMs: frame.ageMs,
      });
    }
    return drawable;
  }
}
